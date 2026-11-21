/**
 * MISSION A21.01 — HARD PAYMENT FREEZE QA (isolated database only).
 *
 * Proves, against a real PostgreSQL database, the real `FrozenPaymentGateway` composition and the real
 * NestJS HTTP API (`AppModule`), that:
 *
 *   1. `QEYNOX_COMMERCE_MODE` resolves to PAYMENTS_DISABLED by default, accepts BETA_FREE, and refuses
 *      every other value (any paid mode) — at resolution and at API boot.
 *   2. In BOTH modes, with Stripe test keys PRESENT and ABSENT, every payment mutation — checkout,
 *      capture, refund, reconciliation and provider webhooks — fails closed with PAYMENTS_FROZEN
 *      (HTTP 503), in-process and over HTTP.
 *   3. ZERO Stripe network calls: every outbound TCP connection from this process is intercepted, and
 *      only loopback (the disposable database and the in-process API) is permitted. A positive control
 *      proves the interceptor really catches a Stripe SDK call before trusting the zero.
 *   4. NO HISTORICAL PAYMENT DATA CHANGES: offers, quotes, acceptances, orders, payments, payment
 *      events and refunds are byte-for-byte identical before and after every frozen call.
 *   5. PREVIOUSLY RECEIVED PROVIDER EVENTS are handled safely: a redelivery of an already-applied event
 *      and a new, correctly signed authorization event are both refused without verification, ledger
 *      write, new authorization, or a payment recorded as successful.
 *   6. Reads keep working truthfully: the payment view reports stored history, withholds stale hosted
 *      checkout links, states the commerce mode, and stays tenant-isolated.
 *
 * HONEST BOUNDARY:
 * - The pre-freeze history is produced by the preserved A08 `PaymentService` driven by an in-process
 *   provider double (checkout/capture/refund) and real HMAC-signed webhook payloads verified by the real
 *   Stripe SDK. That is how such rows would have been written; it is not a copy of production data.
 * - Stripe is never contacted. No browser runs; the payment panel is typechecked and built, not visually
 *   verified.
 */
import 'reflect-metadata';
import { createHmac, randomUUID } from 'node:crypto';
import net from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { asc } from 'drizzle-orm';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  commercialOrders, offers, paymentEvents, payments, quoteAcceptances, quotes, refunds,
} from '@qeynox/persistence';
import {
  COMMERCE_MODES, CommerceService, CompositePaymentProvider, ConfigurationService, DisabledPaymentProvider,
  FrozenPaymentGateway, PaymentService, PlanningService, StripePaymentProvider, createFrozenPaymentGateway,
  resolveCommercePolicy,
  type CheckoutSession, type CheckoutSessionRequest, type CommerceMode, type FrozenPaymentAction,
  type PaymentIntentRequest, type PaymentPort, type PaymentReceipt, type ProviderIntentState, type VerifiedPaymentEvent,
} from '@qeynox/application';
import { DomainError, type ID, type Principal } from '@qeynox/domain';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { createIsolatedQaDatabase } from './qa-isolated-database';

// ── Assertion helpers ────────────────────────────────────────────────────────────────────────────
let assertions = 0;
let groups = 0;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
function pass(message: string): void { groups++; console.log('PASS: ' + message); }
async function expectDomainError(code: string, run: () => Promise<unknown> | unknown, label: string): Promise<DomainError> {
  assertions++;
  try { await run(); } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return error;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code + ' (' + error.message + ')' : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}

// ── Outbound network interceptor ────────────────────────────────────────────────────────────────
// Every TCP/TLS client in Node (http, https, undici fetch, the Stripe SDK, pg) ends in
// net.Socket.prototype.connect. Non-loopback targets are recorded and refused BEFORE any DNS lookup or
// connection, so even a defect could not reach Stripe from this run.
interface OutboundAttempt { host: string; port: string }
const outbound: OutboundAttempt[] = [];
const loopback = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
const originalConnect = net.Socket.prototype.connect;
function installNetworkGuard(): void {
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const first = args[0];
    let host: string | undefined;
    let port: string | undefined;
    let path: string | undefined;
    if (Array.isArray(first)) {
      // Internal normalized form: [options, callback].
      const options = first[0] as { host?: string; port?: number | string; path?: string } | undefined;
      host = options?.host; port = options?.port === undefined ? undefined : String(options.port); path = options?.path;
    } else if (typeof first === 'object' && first !== null) {
      const options = first as { host?: string; port?: number | string; path?: string };
      host = options.host; port = options.port === undefined ? undefined : String(options.port); path = options.path;
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      port = String(first); host = typeof args[1] === 'string' ? args[1] : 'localhost';
    } else if (typeof first === 'string') {
      path = first;
    }
    if (!path && !loopback.has(host ?? 'localhost')) {
      outbound.push({ host: host ?? '(unknown)', port: port ?? '(unknown)' });
      const error = Object.assign(new Error('QA network guard refused outbound connection to ' + String(host) + ':' + String(port)), { code: 'ECONNREFUSED' });
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!loopback.has(url.hostname.replace(/^\[|\]$/g, ''))) {
      outbound.push({ host: url.hostname, port: url.port || (url.protocol === 'https:' ? '443' : '80') });
      throw new TypeError('QA network guard refused fetch to ' + url.hostname);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}
const stripeAttempts = (): OutboundAttempt[] => outbound.filter(attempt => /stripe/i.test(attempt.host));

// ── Provider double for producing PRE-FREEZE history only ───────────────────────────────────────
class HistoryProvider implements PaymentPort {
  readonly sessions: CheckoutSessionRequest[] = [];
  amount = 2500;
  async authorize(_request: PaymentIntentRequest): Promise<never> { throw new DomainError('UNSUPPORTED', 'not used'); }
  async capture(intentId: string): Promise<PaymentReceipt> { return { providerId: intentId, status: 'CAPTURED', amountMinor: this.amount, currency: 'USD' }; }
  async refund(_intentId: string, amountMinor: number): Promise<PaymentReceipt> {
    return { providerId: 're_hist_' + randomUUID(), status: 'CAPTURED', amountMinor, currency: 'USD' };
  }
  async verifyWebhook(): Promise<never> { throw new DomainError('UNSUPPORTED', 'use verifyEvent'); }
  async reconcile(): Promise<undefined> { return undefined; }
  async createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession> {
    this.sessions.push(request);
    return {
      sessionId: 'cs_test_hist_' + request.paymentId, url: 'https://checkout.stripe.test/hist/' + request.paymentId,
      intentId: 'pi_hist_' + request.paymentId, expiresAt: Math.floor(Date.now() / 1000) + request.expiresInSeconds,
    };
  }
  async retrieveIntent(): Promise<ProviderIntentState> { throw new DomainError('UNSUPPORTED', 'not used'); }
}

/** Delegates verifyEvent to the REAL Stripe SDK signature check (local HMAC, no network). */
class SignedEventVerifier implements PaymentPort {
  constructor(private readonly stripe: StripePaymentProvider) {}
  async authorize(): Promise<never> { throw new DomainError('UNSUPPORTED', 'not used'); }
  async capture(): Promise<never> { throw new DomainError('UNSUPPORTED', 'not used'); }
  async refund(): Promise<never> { throw new DomainError('UNSUPPORTED', 'not used'); }
  async verifyWebhook(signature: string, payload: Uint8Array) { return this.stripe.verifyWebhook(signature, payload); }
  async verifyEvent(signature: string, payload: Uint8Array): Promise<VerifiedPaymentEvent> { return this.stripe.verifyEvent(signature, payload); }
  async reconcile(): Promise<undefined> { return undefined; }
}

// ── Stripe-format signing (t=…,v1=HMAC-SHA256(secret, "t.payload")) ──────────────────────────────
const TEST_SECRET_KEY = 'sk_test_' + 'q'.repeat(24);
const TEST_WEBHOOK_SECRET = 'whsec_qa_a21_' + 'w'.repeat(20);
function sign(payload: string, secret = TEST_WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  return 't=' + String(timestamp) + ',v1=' + createHmac('sha256', secret).update(String(timestamp) + '.' + payload).digest('hex');
}
function stripeEvent(type: string, object: Record<string, unknown>, eventId: string, created: number): string {
  return JSON.stringify({ id: eventId, object: 'event', type, created, api_version: '2026-11-18.endive', data: { object } });
}
const intentObject = (orderId: string, id: string, extra: Record<string, unknown> = {}) => ({
  id, object: 'payment_intent', amount: 2500, amount_received: 0, currency: 'usd', status: 'requires_capture', metadata: { orderId }, ...extra,
});

type Env = Record<string, string | undefined>;
interface Combo { readonly mode: CommerceMode; readonly modeValue: string | undefined; readonly keys: boolean; readonly label: string }
const combos: readonly Combo[] = [
  { mode: 'PAYMENTS_DISABLED', modeValue: undefined, keys: false, label: 'default (unset) mode, no Stripe keys' },
  { mode: 'PAYMENTS_DISABLED', modeValue: 'PAYMENTS_DISABLED', keys: true, label: 'PAYMENTS_DISABLED with Stripe test keys' },
  { mode: 'BETA_FREE', modeValue: 'BETA_FREE', keys: false, label: 'BETA_FREE, no Stripe keys' },
  { mode: 'BETA_FREE', modeValue: 'BETA_FREE', keys: true, label: 'BETA_FREE with Stripe test keys' },
];
function applyEnvironment(combo: Pick<Combo, 'modeValue' | 'keys'>): void {
  if (combo.modeValue === undefined) delete process.env.QEYNOX_COMMERCE_MODE; else process.env.QEYNOX_COMMERCE_MODE = combo.modeValue;
  if (combo.keys) {
    process.env.QEYNOX_STRIPE_SECRET_KEY = TEST_SECRET_KEY;
    process.env.QEYNOX_STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  } else {
    delete process.env.QEYNOX_STRIPE_SECRET_KEY;
    delete process.env.QEYNOX_STRIPE_WEBHOOK_SECRET;
  }
}

async function bootApi(): Promise<{ app: INestApplication; base: string }> {
  // abortOnError:false so a refused boot surfaces as a rejected promise instead of process.exit().
  const app = await NestFactory.create(AppModule, { logger: false, rawBody: true, abortOnError: false });
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as { port: number }).port;
  return { app, base: 'http://127.0.0.1:' + String(port) };
}

async function http(base: string, path: string, init: { method?: string; json?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const body = init.raw ?? (init.json === undefined ? undefined : JSON.stringify(init.json));
  const response = await fetch(base + path, {
    method: init.method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  return { status: response.status, body: parsed as Record<string, unknown> };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  installNetworkGuard();
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
  let connection: ReturnType<typeof connectDatabase> | undefined;
  let app: INestApplication | undefined;
  try {
    // ── Group 1 · the interceptor really catches a Stripe SDK call (positive control) ─────────────
    const control = new StripePaymentProvider({ secretKey: TEST_SECRET_KEY, webhookSecret: TEST_WEBHOOK_SECRET });
    let controlFailed = false;
    try { await control.retrieveIntent('pi_qa_network_control'); } catch { controlFailed = true; }
    assert(controlFailed, 'the positive-control Stripe call did not succeed');
    assert(stripeAttempts().length >= 1, 'the network guard detected the Stripe SDK attempting to reach Stripe, got ' + JSON.stringify(outbound));
    outbound.length = 0;
    pass('positive control: a real Stripe SDK call is detected and refused by the network guard before connecting');

    // ── Group 2 · mode resolution is server-authoritative and has no paid mode ───────────────────
    assert(resolveCommercePolicy(undefined).mode === 'PAYMENTS_DISABLED', 'unset resolves to PAYMENTS_DISABLED');
    assert(resolveCommercePolicy('').mode === 'PAYMENTS_DISABLED', 'empty resolves to PAYMENTS_DISABLED');
    assert(resolveCommercePolicy('   ').mode === 'PAYMENTS_DISABLED', 'blank resolves to PAYMENTS_DISABLED');
    assert(resolveCommercePolicy('PAYMENTS_DISABLED').mode === 'PAYMENTS_DISABLED', 'PAYMENTS_DISABLED resolves');
    const beta = resolveCommercePolicy(' BETA_FREE ');
    assert(beta.mode === 'BETA_FREE' && beta.betaFree === true, 'BETA_FREE resolves and is flagged as free beta');
    assert(isDeepStrictEqual([...COMMERCE_MODES], ['PAYMENTS_DISABLED', 'BETA_FREE']), 'exactly two modes exist and neither is a paid mode');
    for (const mode of COMMERCE_MODES) {
      const policy = resolveCommercePolicy(mode);
      assert(policy.paymentsFrozen === true && policy.financialTransactionsAllowed === false, mode + ' freezes payments and allows no financial transaction');
      assert(Object.isFrozen(policy), mode + ' policy object is immutable');
    }
    for (const value of ['PAID', 'STRIPE', 'LIVE', 'PAYMENTS_ENABLED', 'paid', 'beta_free', 'payments_disabled', 'TEST', 'BETA_FREE,PAID']) {
      await expectDomainError('NOT_CONFIGURED', () => resolveCommercePolicy(value), 'unsupported mode ' + value);
    }
    pass('QEYNOX_COMMERCE_MODE defaults to PAYMENTS_DISABLED, accepts BETA_FREE, and refuses every other value');

    // ── Fixture · database, HTTP tenants, a paid offer and PRE-FREEZE payment history ───────────
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total && report.applied.includes('0019_payments.sql'), 'disposable QA database migrated including the payments migration');
    connection = connectDatabase(qa.url);
    const store = new QeyNoxStore(connection.db);

    applyEnvironment({ modeValue: undefined, keys: false });
    const firstBoot = await bootApi();
    app = firstBoot.app;
    let apiBase = firstBoot.base;
    const register = async (label: string) => {
      const response = await http(apiBase, '/v1/auth/register', {
        json: { email: 'qa-a21-' + label + '-' + randomUUID().slice(0, 8) + '@example.invalid', password: 'qa-a21-strong-password-' + label, workspaceName: 'QA A21 ' + label },
      });
      assert(response.status === 201, 'registered ' + label + ' over HTTP, got ' + String(response.status));
      const auth = response.body as unknown as { token: string; userId: string; workspaceId: string };
      return {
        principal: { userId: auth.userId as ID, workspaceId: auth.workspaceId as ID, roles: ['OWNER'] } as Principal,
        headers: { authorization: 'Bearer ' + auth.token, 'x-qeynox-workspace': auth.workspaceId },
        userId: auth.userId,
      };
    };
    const buyer = await register('buyer');
    const outsider = await register('outsider');
    const owner = buyer.principal;

    process.env.QEYNOX_OPERATOR_USER_IDS = buyer.userId;
    await new ConfigurationService(store).apply(owner, {
      idempotencyKey: 'qa-a21-config-1',
      entries: [
        {
          domain: 'TOOL', connectorId: 'world-bank', version: '1', status: 'ACTIVE',
          manifest: {
            description: 'QA A21 declaration so the verification policy has a configured provider; never invoked',
            provider: 'World Bank', regions: ['GLOBAL'], operations: ['INDICATOR_RESEARCH'], mode: 'READ_ONLY',
            licenseNotes: 'QA verification only', termsUrl: 'https://datahelpdesk.worldbank.org/knowledgebase/articles/889392',
            freshness: { ttlSeconds: 86400, publishedAtSource: 'UNKNOWN' },
            rateLimit: { maxPerMinute: 5 }, tools: [{ name: 'indicator', version: '1' }],
          },
        },
        { domain: 'BUSINESS_CAPABILITY', slot: 1, version: 1, status: 'ACTIVE', name: 'QA A21 Capability', purpose: 'QA-only paid capability', scope: ['QA A21 scope'], allowedTools: ['world-bank:indicator@1'], privacyScopes: [], inputSchemaVersion: 1, outputSchemaVersion: 1, maximumSteps: 5, maximumToolCalls: 2 },
        { domain: 'VERIFICATION_POLICY', capabilityId: 'capability-slot-1-v1', version: 1, status: 'ACTIVE', minimumSources: 1, maxAgeDays: 30, approvedProviders: ['world-bank'], humanReviewRequired: true, validFrom: '2026-01-01T00:00:00.000Z' },
        {
          domain: 'RAAS_OFFER', offerId: 'qa-a21-paid-offer', version: 1, status: 'ACTIVE', label: 'QA A21 Paid Offer',
          capabilityIds: ['capability-slot-1-v1'], deliverableSchemaVersion: 1, scope: ['QA A21 scope'], exclusions: [],
          regions: ['GLOBAL'], locales: ['en'], termsVersion: 'qa-a21-terms-v1', currency: 'USD', amountMinor: 2500,
          taxPolicy: 'CONFIGURED', isExplicitlyFree: false,
        },
        { domain: 'BUDGET_POLICY', policyId: 'default', version: 1, status: 'ACTIVE', currency: 'USD', maxMoneyMinor: 1000, maxAgentCalls: 10, maxToolCalls: 10, maxDurationSeconds: 600, maxConcurrent: 2, unitMaxMinor: { hermes: 10 } },
      ],
    } as never);

    const commerce = new CommerceService(store);
    const planning = new PlanningService(store);
    const paidOrder = async (label: string) => {
      const operation = await store.createOperation(owner, 'QA A21 ' + label, 'QA A21 payment freeze objective', []);
      const plan = await planning.create(owner, operation.id, operation.version, [{
        title: 'QA A21 step', description: 'QA A21 step description', capabilityId: 'capability-slot-1-v1' as ID, dependsOnIndices: [], intent: 'RESEARCH',
      }]);
      const quote = await commerce.quote(owner, operation.id, 'qa-a21-paid-offer', plan.revision.id) as { id: string };
      const accepted = await commerce.accept(owner, quote.id as ID, 'qa-a21-accept-' + label + '-' + randomUUID().slice(0, 8));
      return { operationId: operation.id, orderId: accepted.orderId as ID };
    };

    // Pre-freeze history, written by the preserved A08 engine exactly as it would have been.
    const history = new HistoryProvider();
    const disabled = new DisabledPaymentProvider();
    const engine = new PaymentService(store, new CompositePaymentProvider(history, disabled));
    const webhookEngine = new PaymentService(store, new CompositePaymentProvider(new SignedEventVerifier(new StripePaymentProvider({ secretKey: TEST_SECRET_KEY, webhookSecret: TEST_WEBHOOK_SECRET })), disabled));
    const redirects = { successUrl: 'https://app.qeynox.test/return?payment=returned', cancelUrl: 'https://app.qeynox.test/return?payment=cancelled' };
    const deliver = async (type: string, eventId: string, created: number, object: Record<string, unknown>) => {
      const payload = stripeEvent(type, object, eventId, created);
      return { payload, signature: sign(payload), result: await webhookEngine.handleWebhook(sign(payload), new TextEncoder().encode(payload), '') };
    };
    const intentOf = async (orderId: string) => (await connection!.db.select().from(payments)).find(row => row.orderId === orderId)!.providerIntentId!;
    const created = Math.floor(Date.now() / 1000) - 600;

    const open = await paidOrder('open-checkout');
    await engine.startCheckout(owner, open.operationId, open.orderId, 'qa-a21-hist-open-0001', redirects, 3600);
    const authorized = await paidOrder('authorized');
    await engine.startCheckout(owner, authorized.operationId, authorized.orderId, 'qa-a21-hist-auth-0001', redirects);
    const authorizedIntent = await intentOf(authorized.orderId);
    const previouslyReceived = await deliver('payment_intent.amount_capturable_updated', 'evt_qa_a21_hist_auth', created, intentObject(authorized.orderId, authorizedIntent));
    assert(previouslyReceived.result.status === 'APPLIED', 'pre-freeze: a signed authorization was applied');
    const captured = await paidOrder('captured-refunded');
    await engine.startCheckout(owner, captured.operationId, captured.orderId, 'qa-a21-hist-capt-0001', redirects);
    const capturedIntent = await intentOf(captured.orderId);
    assert((await deliver('payment_intent.amount_capturable_updated', 'evt_qa_a21_hist_capt', created + 1, intentObject(captured.orderId, capturedIntent))).result.status === 'APPLIED', 'pre-freeze: second authorization applied');
    await engine.capture(owner, captured.operationId, captured.orderId, 'qa-a21-hist-capture-01');
    await engine.refund(owner, captured.operationId, captured.orderId, 1000, 'QA A21 pre-freeze partial refund', 'qa-a21-hist-refund-01');
    const orphan = await deliver('payment_intent.amount_capturable_updated', 'evt_qa_a21_hist_orphan', created + 2, intentObject('order-that-does-not-exist', 'pi_qa_a21_orphan'));
    assert(orphan.result.status === 'UNRESOLVED', 'pre-freeze: an orphan event was recorded as UNRESOLVED');
    const unpaid = await paidOrder('unpaid');

    const orderState = async (orderId: string) => (await connection!.db.select().from(commercialOrders)).find(row => row.id === orderId)!.state;
    assert(await orderState(open.orderId) === 'PAYMENT_REQUIRED', 'fixture: open checkout order awaits payment');
    assert(await orderState(authorized.orderId) === 'AUTHORIZED', 'fixture: authorized order is AUTHORIZED');
    assert(await orderState(unpaid.orderId) === 'PAYMENT_REQUIRED', 'fixture: unpaid order awaits payment');
    const capturedRow = (await connection.db.select().from(payments)).find(row => row.orderId === captured.orderId)!;
    assert(capturedRow.status === 'CAPTURED' && capturedRow.capturedMinor === 2500 && capturedRow.refundedMinor === 1000, 'fixture: captured payment with a partial refund');
    assert(history.sessions.length === 3, 'fixture: three historical checkout sessions');

    // ── Historical snapshot: every commerce table, ordered, compared deeply after every frozen call ─
    const snapshot = async () => ({
      offers: await connection!.db.select().from(offers).orderBy(asc(offers.id), asc(offers.version)),
      quotes: await connection!.db.select().from(quotes).orderBy(asc(quotes.id)),
      acceptances: await connection!.db.select().from(quoteAcceptances).orderBy(asc(quoteAcceptances.id)),
      orders: await connection!.db.select().from(commercialOrders).orderBy(asc(commercialOrders.id)),
      payments: await connection!.db.select().from(payments).orderBy(asc(payments.id)),
      paymentEvents: await connection!.db.select().from(paymentEvents).orderBy(asc(paymentEvents.id)),
      refunds: await connection!.db.select().from(refunds).orderBy(asc(refunds.id)),
    });
    const baseline = await snapshot();
    assert(baseline.payments.length === 3 && baseline.refunds.length === 1 && baseline.paymentEvents.length >= 3, 'baseline captures the historical payments, refund and ledger');
    assert(baseline.offers.some(row => row.amountMinor === 2500), 'baseline captures the published price');
    const assertUnchanged = async (label: string) => {
      const now = await snapshot();
      for (const key of Object.keys(baseline) as (keyof typeof baseline)[]) {
        assert(isDeepStrictEqual(now[key], baseline[key]), 'historical ' + key + ' unchanged after ' + label);
      }
    };
    pass('fixture: pre-freeze history (open checkout, authorized, captured+refunded, orphan event, unpaid order) recorded and snapshotted');

    // Signed provider events for the freeze checks: a redelivery of an already-applied event, and a
    // NEW authorization that, if processed, would authorize the open-checkout order.
    const openIntent = await intentOf(open.orderId);
    const redelivery = { payload: previouslyReceived.payload, signature: sign(previouslyReceived.payload) };
    const freshPayload = stripeEvent('payment_intent.amount_capturable_updated', intentObject(open.orderId, openIntent), 'evt_qa_a21_new_auth', Math.floor(Date.now() / 1000));
    const fresh = { payload: freshPayload, signature: sign(freshPayload) };
    const capturePayload = stripeEvent('payment_intent.succeeded', intentObject(authorized.orderId, authorizedIntent, { status: 'succeeded', amount_received: 2500 }), 'evt_qa_a21_new_success', Math.floor(Date.now() / 1000));
    const success = { payload: capturePayload, signature: sign(capturePayload) };

    // ── Group 3..6 · in-process gateway, every mode × Stripe keys present/absent ────────────────
    const mutationActions: readonly FrozenPaymentAction[] = ['CHECKOUT', 'CAPTURE', 'REFUND', 'RECONCILE', 'WEBHOOK'];
    for (const combo of combos) {
      applyEnvironment(combo);
      const gateway = createFrozenPaymentGateway(store, process.env as Env);
      assert(gateway instanceof FrozenPaymentGateway && gateway.providerBinding === 'FROZEN', combo.label + ': the API composition binds the frozen provider');
      assert(gateway.policy.mode === combo.mode, combo.label + ': resolved mode ' + gateway.policy.mode);
      assert(combo.keys === Boolean(process.env.QEYNOX_STRIPE_SECRET_KEY), combo.label + ': Stripe key presence is as intended');

      for (const action of mutationActions) {
        const error = await expectDomainError('PAYMENTS_FROZEN', () => gateway.assertMutationAllowed(action), combo.label + ': guard for ' + action);
        assert(error.context?.mode === combo.mode && error.context?.action === action, combo.label + ': refusal names mode and action');
      }
      await expectDomainError('PAYMENTS_FROZEN', () => gateway.startCheckout(owner, open.operationId, open.orderId, 'qa-a21-frozen-checkout-1', redirects), combo.label + ': checkout');
      await expectDomainError('PAYMENTS_FROZEN', () => gateway.startCheckout(owner, unpaid.operationId, unpaid.orderId, 'qa-a21-frozen-checkout-2', redirects), combo.label + ': checkout on an unpaid order');
      await expectDomainError('PAYMENTS_FROZEN', () => gateway.capture(owner, authorized.operationId, authorized.orderId, 'qa-a21-frozen-capture-1'), combo.label + ': capture of an authorized payment');
      await expectDomainError('PAYMENTS_FROZEN', () => gateway.refund(owner, captured.operationId, captured.orderId, 500, 'QA A21 frozen refund', 'qa-a21-frozen-refund-1'), combo.label + ': refund of a captured payment');
      for (const target of [open, authorized, captured, unpaid]) {
        await expectDomainError('PAYMENTS_FROZEN', () => gateway.reconcileOrder(owner, target.operationId, target.orderId), combo.label + ': reconcile');
      }
      for (const [label, event] of [['redelivered already-applied event', redelivery], ['new signed authorization', fresh], ['new signed success', success]] as const) {
        await expectDomainError('PAYMENTS_FROZEN', () => gateway.handleWebhook(event.signature, new TextEncoder().encode(event.payload), ''), combo.label + ': webhook ' + label);
      }
      // Cross-tenant mutation attempts are refused the same way: freeze first, nothing disclosed.
      await expectDomainError('PAYMENTS_FROZEN', () => gateway.refund(outsider.principal, captured.operationId, captured.orderId, 500, 'QA A21 outsider refund', 'qa-a21-frozen-refund-2'), combo.label + ': outsider refund');
      pass(combo.label + ': checkout, capture, refund, reconcile and webhooks fail closed with PAYMENTS_FROZEN in-process');

      // Reads remain truthful and frozen.
      const openView = await gateway.view(owner, open.operationId);
      assert(openView.payment?.status === 'CREATED', combo.label + ': open checkout history is reported as stored');
      assert(openView.payment?.checkoutUrl === null, combo.label + ': a stale hosted checkout link is withheld during the freeze');
      assert(openView.canStartCheckout === false && openView.providerConfigured === false, combo.label + ': no checkout is offered and no provider is reported');
      assert(openView.blockedReason === 'PAYMENTS_FROZEN', combo.label + ': blocked reason is PAYMENTS_FROZEN');
      assert(openView.executionAuthorized === false, combo.label + ': the open order is not authorized');
      assert(isDeepStrictEqual(openView.commerce, { mode: combo.mode, paymentsAvailable: false, checkoutAvailable: false, refundsAvailable: false, betaFree: combo.mode === 'BETA_FREE', reason: 'PAYMENTS_FROZEN' }), combo.label + ': availability block states the server mode');
      const authorizedView = await gateway.view(owner, authorized.operationId);
      assert(authorizedView.orderState === 'AUTHORIZED' && authorizedView.payment?.status === 'AUTHORIZED' && authorizedView.executionAuthorized === true, combo.label + ': a pre-freeze authorization is reported unchanged (not revoked, not upgraded)');
      const capturedView = await gateway.view(owner, captured.operationId);
      assert(capturedView.payment?.status === 'CAPTURED' && capturedView.payment.capturedMinor === 2500 && capturedView.payment.refundedMinor === 1000, combo.label + ': captured/refunded amounts are reported as stored');
      assert(capturedView.refunds.length === 1 && capturedView.refunds[0]!.amountMinor === 1000, combo.label + ': the historical refund is listed');
      const unpaidView = await gateway.view(owner, unpaid.operationId);
      assert(unpaidView.payment === null && unpaidView.orderState === 'PAYMENT_REQUIRED' && unpaidView.canStartCheckout === false, combo.label + ': an unpaid order stays PAYMENT_REQUIRED with no checkout');
      const returned = await gateway.confirmReturn(owner, open.operationId, open.orderId);
      assert(returned.provider === null && returned.payment?.checkoutUrl === null && returned.orderState === 'PAYMENT_REQUIRED', combo.label + ': the return page reads the database only and authorizes nothing');
      await expectDomainError('NOT_FOUND', () => gateway.view(outsider.principal, open.operationId), combo.label + ': an outsider cannot read the payment view');
      await expectDomainError('NOT_FOUND', () => gateway.confirmReturn(outsider.principal, open.operationId, open.orderId), combo.label + ': an outsider cannot use the return page');
      await assertUnchanged(combo.label + ' in-process');
      assert(outbound.length === 0, combo.label + ': zero outbound network attempts in-process, got ' + JSON.stringify(outbound));
      pass(combo.label + ': reads report history truthfully, withhold stale checkout links, and change nothing');
    }

    // ── Group 7..10 · the real HTTP API, every mode × Stripe keys present/absent ────────────────
    await app.close(); app = undefined;
    for (const combo of combos) {
      applyEnvironment(combo);
      const booted = await bootApi();
      app = booted.app; apiBase = booted.base;
      const h = buyer.headers;
      const op = (id: string) => '/v1/operations/' + id;

      const availability = await http(apiBase, '/v1/commerce/availability', { headers: h });
      assert(availability.status === 200 && availability.body.mode === combo.mode && availability.body.paymentsAvailable === false && availability.body.betaFree === (combo.mode === 'BETA_FREE'), combo.label + ': GET /v1/commerce/availability states the mode');
      const anonymousAvailability = (await http(apiBase, '/v1/commerce/availability')).status;
      assert(anonymousAvailability === 401 || anonymousAvailability === 403, combo.label + ': availability requires a session, got ' + String(anonymousAvailability));

      const expectFrozen = (response: { status: number; body: Record<string, unknown> }, label: string) => {
        const envelope = response.body.error as { code?: string; message?: string } | undefined;
        assert(response.status === 503 && envelope?.code === 'PAYMENTS_FROZEN' && /no provider was contacted/.test(envelope.message ?? ''), combo.label + ': ' + label + ' → 503 PAYMENTS_FROZEN, got ' + String(response.status) + ' ' + JSON.stringify(response.body));
      };
      expectFrozen(await http(apiBase, op(open.operationId) + '/payments/checkout', { headers: h, json: { orderId: open.orderId, idempotencyKey: 'qa-a21-http-checkout-1', successUrl: redirects.successUrl, cancelUrl: redirects.cancelUrl } }), 'POST checkout');
      expectFrozen(await http(apiBase, op(unpaid.operationId) + '/payments/checkout', { headers: h, json: {} }), 'POST checkout with an empty body (freeze precedes validation)');
      expectFrozen(await http(apiBase, op(authorized.operationId) + '/payments/capture', { headers: h, json: { orderId: authorized.orderId, idempotencyKey: 'qa-a21-http-capture-1' } }), 'POST capture');
      expectFrozen(await http(apiBase, op(captured.operationId) + '/payments/refund', { headers: h, json: { orderId: captured.orderId, amountMinor: 500, reason: 'QA A21 HTTP refund', idempotencyKey: 'qa-a21-http-refund-1' } }), 'POST refund');
      expectFrozen(await http(apiBase, op(authorized.operationId) + '/payments/reconcile', { headers: h, json: { orderId: authorized.orderId, idempotencyKey: 'qa-a21-http-reconcile-1' } }), 'POST reconcile');
      expectFrozen(await http(apiBase, op(captured.operationId) + '/payments/refund', { headers: outsider.headers, json: { orderId: captured.orderId, amountMinor: 500, reason: 'QA A21 outsider', idempotencyKey: 'qa-a21-http-refund-2' } }), 'POST refund by another tenant');
      for (const [label, event] of [['redelivered already-applied event', redelivery], ['new signed authorization', fresh], ['new signed success', success]] as const) {
        expectFrozen(await http(apiBase, '/v1/payments/webhook/stripe', { raw: event.payload, headers: { 'stripe-signature': event.signature } }), 'webhook ' + label);
      }
      expectFrozen(await http(apiBase, '/v1/payments/webhook/stripe', { raw: '{}' }), 'unsigned webhook (refused before the signature is read)');
      for (const path of ['/payments/checkout', '/payments/capture', '/payments/refund', '/payments/reconcile']) {
        const anonymous = await http(apiBase, op(open.operationId) + path, { json: {} });
        assert(anonymous.status === 401 || anonymous.status === 403, combo.label + ': anonymous ' + path + ' is refused, got ' + String(anonymous.status));
      }
      pass(combo.label + ': every payment mutation route fails closed over HTTP, including signed provider webhooks');

      const view = await http(apiBase, op(open.operationId) + '/payment', { headers: h });
      assert(view.status === 200 && view.body.canStartCheckout === false && view.body.providerConfigured === false && view.body.blockedReason === 'PAYMENTS_FROZEN', combo.label + ': GET payment view is frozen');
      assert((view.body.payment as { checkoutUrl: unknown }).checkoutUrl === null, combo.label + ': HTTP view withholds the stale checkout link');
      assert((view.body.commerce as { mode: string }).mode === combo.mode, combo.label + ': HTTP view carries the commerce mode');
      const returnedHttp = await http(apiBase, op(open.operationId) + '/payments/return', { headers: { ...h, 'x-order-id': open.orderId } });
      assert(returnedHttp.status === 200 && returnedHttp.body.provider === null && returnedHttp.body.orderState === 'PAYMENT_REQUIRED', combo.label + ': GET return reads only and authorizes nothing');
      assert((await http(apiBase, op(open.operationId) + '/payment', { headers: outsider.headers })).status === 404, combo.label + ': another tenant cannot read the payment view');
      const readiness = await http(apiBase, op(unpaid.operationId) + '/readiness', { headers: h });
      assert(readiness.status === 200, combo.label + ': readiness is readable, got ' + String(readiness.status));
      const blockers = (readiness.body.blockers as { code: string }[] | undefined) ?? [];
      assert(blockers.some(blocker => blocker.code === 'PAYMENTS_FROZEN'), combo.label + ': readiness names the freeze for an unpaid paid order, got ' + JSON.stringify(blockers.map(blocker => blocker.code)));
      assert(!blockers.some(blocker => blocker.code === 'PAYMENT_NOT_CONFIGURED'), combo.label + ': readiness no longer blames a missing provider');

      await app.close(); app = undefined;
      await assertUnchanged(combo.label + ' over HTTP');
      assert(outbound.length === 0, combo.label + ': zero outbound network attempts over HTTP, got ' + JSON.stringify(outbound));
      pass(combo.label + ': HTTP reads are frozen and truthful; historical data unchanged; zero Stripe calls');
    }

    // ── Group 11 · a paid mode cannot boot the API, keys or not ────────────────────────────────
    for (const [value, keys] of [['PAID', true], ['STRIPE', true], ['LIVE', false]] as const) {
      applyEnvironment({ modeValue: value, keys });
      let refused: unknown;
      try { const booted = await bootApi(); await booted.app.close(); } catch (error: unknown) { refused = error; }
      assert(refused !== undefined, 'API boot with QEYNOX_COMMERCE_MODE=' + value + (keys ? ' and Stripe keys' : '') + ' is refused');
      assert(String(refused instanceof Error ? refused.message : refused).includes('QEYNOX_COMMERCE_MODE'), 'the boot refusal names QEYNOX_COMMERCE_MODE');
    }
    await assertUnchanged('refused paid-mode boots');
    pass('a paid QEYNOX_COMMERCE_MODE refuses to boot the API even with Stripe test keys present');

    // ── Group 12 · global network and data verdict ─────────────────────────────────────────────
    assert(stripeAttempts().length === 0 && outbound.length === 0, 'zero Stripe and zero non-loopback network attempts after the positive control');
    await assertUnchanged('the whole run');
    const ledger = await connection.db.select().from(paymentEvents);
    assert(!ledger.some(row => row.providerEventId === 'stripe:evt_qa_a21_new_auth' || row.providerEventId === 'stripe:evt_qa_a21_new_success'), 'no event received during the freeze was written to the ledger');
    assert(ledger.filter(row => row.providerEventId === 'stripe:evt_qa_a21_hist_auth').length === 1, 'the previously received event still has exactly one ledger row');
    pass('global: zero Stripe network calls, no ledger writes, and all historical commerce data unchanged');

    console.log('\nPayment freeze A21.01 — ' + String(groups) + ' groups, ' + String(assertions) + ' assertions PASS in ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
    console.log('BOUNDARY: Stripe was never contacted (outbound connections intercepted; positive control proved detection). Pre-freeze history was written by the preserved A08 engine with an in-process provider double and real HMAC-signed events. No browser ran.');
  } finally {
    if (app) await app.close().catch(() => undefined);
    if (connection) await connection.close().catch(() => undefined);
    net.Socket.prototype.connect = originalConnect;
    await qa.drop().catch(() => undefined);
    console.log('QA database dropped: ' + qa.name);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
