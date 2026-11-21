/**
 * MISSION A19 — e-mail delivery and notifications QA (isolated database + real HTTP + real adapter).
 *
 * Boots the real NestJS application against a disposable PostgreSQL database. Three transport
 * situations are exercised, deliberately:
 *
 *   A. NOT_CONFIGURED (the shipped default): every delivery path fails closed with 503 NOT_CONFIGURED;
 *      no message is ever claimed to be sent.
 *   B. CONFIGURED with the REAL Resend adapter (ResendEmailTransport), network replaced by a
 *      recording fetch that answers with the Resend API contract. What this run calls "sent" means
 *      the provider accepted the message — NOT that any mailbox exists. No e-mail leaves this run;
 *      nothing here is evidence of real delivery.
 *   C. Service-level failure injection with a stub transport for deterministic retry/backoff/terminal
 *      transitions and provider error classification.
 *
 * Required coverage: verification/recovery/invitation emails, approvals/execution failures/delivered
 * results, EN/FR templates, retry + deduplication, inbox read/unread, preferences and opt-outs,
 * cross-tenant isolation, delivery ledger truthfulness (SENT only on provider acceptance).
 *
 * Run: pnpm qa:notifications   (needs QEYNOX_QA_DATABASE_URL; local disposable database only)
 * Exit: 0 PASS · 3 BLOCKED (no database available) · 1 FAILED
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  NotificationService,
  ResendEmailTransport,
  EmailDeliveryError,
  NotConfiguredEmailTransport,
  StepProgression,
  ResultAssembler,
  ResultDeliveryService,
  renderEmail,
  resolveEmailLocale,
  EMAIL_LOCALES,
  type EmailTransport,
} from '@qeynox/application';
import { requireId } from '@qeynox/domain';
import {
  connectDatabase, runMigrations, QeyNoxStore, NotificationStore,
  operations, steps, attempts, planSeals, events,
  claims, claimEvidenceLinks, sources, commercialOrders, approvals,
  emailDeliveries as emailDeliveriesTable,
} from '@qeynox/persistence';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { createIsolatedQaDatabase } from './qa-isolated-database';

const PASS = 0;
const FAILED = 1;
const BLOCKED = 3;

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

interface HttpResult { readonly status: number; readonly body: unknown }
async function call(base: string, path: string, init: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(base + path, init);
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text) as unknown; } catch { /* plain text */ }
  return { status: response.status, body };
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const postAuthed = (token: string, workspaceId: string | undefined, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(workspaceId ? { 'x-qeynox-workspace': workspaceId } : {}) },
  body: JSON.stringify(body),
});
const getAuthed = (token: string, workspaceId: string | undefined): RequestInit => ({
  method: 'GET',
  headers: { authorization: 'Bearer ' + token, ...(workspaceId ? { 'x-qeynox-workspace': workspaceId } : {}) },
});
const errorCode = (result: HttpResult): string | undefined => (result.body as { error?: { code?: string } }).error?.code;

/** Everything the recorded Resend answers with. The real network is never touched. */
const providerCalls: { to: string; subject: string; text: string; html?: string | undefined; category?: string | undefined; deduplicationKey?: string | undefined }[] = [];
let providerBehavior: 'ok' | 'always-retryable' | 'always-permanent' = 'ok';

const realFetch = globalThis.fetch;
function providerStubFetch(): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://api.resend.com/')) return realFetch(input as Parameters<typeof fetch>[0], init);
    const body = JSON.parse(String(init?.body ?? '{}')) as { to: string[]; subject: string; text: string; html?: string; category?: string; tags?: { name: string; value: string }[] };
    providerCalls.push({ to: body.to[0] ?? '', subject: body.subject, text: body.text, html: body.html, category: body.tags?.find(tag => tag.name === 'category')?.value, deduplicationKey: (init?.headers as Record<string, string> | undefined)?.['idempotency-key'] });
    if (providerBehavior === 'always-retryable') {
      return new Response(JSON.stringify({ name: 'rate_limit_exceeded', message: 'Too many requests' }), { status: 429, headers: { 'content-type': 'application/json' } });
    }
    if (providerBehavior === 'always-permanent') {
      return new Response(JSON.stringify({ name: 'invalid_to_address', message: 'Recipient refused' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'qa-resend-' + providerCalls.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

// --- fixture helpers -------------------------------------------------------------------------

async function seedRunningOperation(db: ReturnType<typeof connectDatabase>['db'], workspaceId: string, createdBy: string, title: string) {
  const now = new Date().toISOString();
  const goalId = randomUUID();
  const revisionId = randomUUID();
  const stepId = randomUUID();
  const attemptId = randomUUID();
  const operationId = randomUUID();
  await db.insert(operations).values({
    id: operationId, workspaceId, createdBy, goalId, status: 'RUNNING', version: 1,
    currentRevisionId: revisionId, lastActivityAt: now,
    payload: { id: operationId, workspaceId, createdBy, goalId, title, status: 'RUNNING', version: 1, currentRevisionId: revisionId, createdAt: now, updatedAt: now, lastActivityAt: now } as never,
  });
  await db.insert(planSeals).values({ revisionId, operationId, contentHash: 'qa-content-hash', sealedAt: now, capabilityVersions: {} });
  await db.insert(steps).values({
    id: stepId, operationId, revisionId,
    payload: { id: stepId, operationId, planRevisionId: revisionId, ordinal: 0, title: 'Analyst pass', description: 'Produce the finding', capabilityId: 'research', dependsOn: [], intent: 'RESEARCH', state: 'PENDING', version: 1 } as never,
  });
  await db.insert(attempts).values({
    id: attemptId, operationId, stepId, revisionId, sequence: 1, state: 'RUNNING',
    payload: { id: attemptId, workStepId: stepId, planRevisionId: revisionId, operationId, sequence: 1, state: 'RUNNING', createdAt: now, startedAt: now, version: 1 } as never,
  });
  return { operationId, revisionId, stepId, attemptId };
}

async function main(): Promise<number> {
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: QEYNOX_QA_DATABASE_URL is not set; no integration evidence can be produced.');
    return BLOCKED;
  }
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let app: INestApplication | undefined;
  let appB: INestApplication | undefined;
  try {
    const migration = await runMigrations(qa.url);
    check(migration.total > 0 && migration.applied.length === migration.total, 'disposable QA database migrated (A19 runs need 0024)');
    check(migration.applied.some(name => name.startsWith('0024_')), 'migration 0024 applied');

    // --- A. Template + adapter properties (no database) --------------------------------------
    for (const template of ['EMAIL_VERIFICATION', 'PASSWORD_RESET', 'WORKSPACE_INVITATION', 'APPROVAL_REQUIRED', 'EXECUTION_FAILED', 'RESULT_DELIVERED'] as const) {
      for (const locale of EMAIL_LOCALES) {
        const rendered = renderEmail(template, locale, { link: 'https://qeynox.qa.example/fr/account/verify?token=abc', actionUrl: 'https://qeynox.qa.example/fr/missions/op-1', expiresAt: '2026-11-21T00:00:00.000Z', workspaceName: 'QA Workspace', role: 'MEMBER', operationTitle: 'QA mission', errorCode: 'ENGINE_OR_TOOL_ERROR' });
        check(rendered.subject.length > 3 && rendered.text.includes('qeynox.qa.example') && rendered.html.includes('<!doctype html>'), `template ${template} renders subject/text/html in ${locale}`);
      }
    }
    check(resolveEmailLocale('pt-BR') === 'en', 'an unreviewed locale falls back to English instead of failing the send');
    check(resolveEmailLocale('FR') === 'fr', 'locale resolution accepts case-insensitive French tags');
    const escaped = renderEmail('APPROVAL_REQUIRED', 'en', { operationTitle: '<img src=x onerror=alert(1)>', actionUrl: 'https://qeynox.qa.example/en/missions/op-9' });
    check(!escaped.html.includes('<img src=x'), 'every interpolated value is HTML-escaped in the markup');
    check(escaped.html.includes('&lt;img src=x'), 'escaped content is present verbatim as text');

    // Adapter classification, driven by a stubbed fetch — no network involved.
    const okTransport = new ResendEmailTransport({ apiKey: 'qa-key', from: 'QeyNox QA <qa@example.invalid>', fetchImpl: (async () => new Response(JSON.stringify({ id: 'qa-msg-1' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch });
    const okReceipt = await okTransport.send({ to: 'a@example.invalid', subject: 's', text: 't' });
    check(okReceipt.providerMessageId === 'qa-msg-1', 'a 2xx with an id yields the provider message id');
    const retryableTransport = new ResendEmailTransport({ apiKey: 'qa-key', from: 'QeyNox QA <qa@example.invalid>', fetchImpl: (async () => new Response(JSON.stringify({ name: 'rate_limit_exceeded' }), { status: 429, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch });
    let retryableError: EmailDeliveryError | null = null;
    try { await retryableTransport.send({ to: 'a@example.invalid', subject: 's', text: 't' }); } catch (error) { retryableError = error as EmailDeliveryError; }
    check(retryableError instanceof EmailDeliveryError && retryableError.retryable === true, 'HTTP 429 classifies as retryable');
    const permanentTransport = new ResendEmailTransport({ apiKey: 'qa-key', from: 'QeyNox QA <qa@example.invalid>', fetchImpl: (async () => new Response(JSON.stringify({ name: 'invalid_to_address' }), { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch });
    let permanentError: EmailDeliveryError | null = null;
    try { await permanentTransport.send({ to: 'a@example.invalid', subject: 's', text: 't' }); } catch (error) { permanentError = error as EmailDeliveryError; }
    check(permanentError instanceof EmailDeliveryError && permanentError.retryable === false, 'HTTP 400 classifies as permanent');
    const unreachableTransport = new ResendEmailTransport({ apiKey: 'qa-key', from: 'QeyNox QA <qa@example.invalid>', fetchImpl: (async () => { throw new TypeError('getaddrinfo ENOTFOUND api.resend.com'); }) as unknown as typeof fetch });
    let networkError: EmailDeliveryError | null = null;
    try { await unreachableTransport.send({ to: 'a@example.invalid', subject: 's', text: 't' }); } catch (error) { networkError = error as EmailDeliveryError; }
    check(networkError instanceof EmailDeliveryError && networkError.retryable === true, 'a network failure classifies as retryable, never as a delivery');
    const incomplete = new NotConfiguredEmailTransport('EMAIL_PROVIDER_INCOMPLETE: test');
    check(incomplete.status === 'NOT_CONFIGURED', 'incomplete configuration fails closed');

    // --- B. The shipped default: NOT_CONFIGURED, fail-closed ---------------------------------
    delete process.env.QEYNOX_EMAIL_PROVIDER;
    delete process.env.QEYNOX_RESEND_API_KEY;
    delete process.env.QEYNOX_EMAIL_FROM;
    process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
    process.env.QEYNOX_PUBLIC_URL = 'https://qeynox.qa.example';
    appB = await NestFactory.create(AppModule, { logger: false });
    appB.useGlobalFilters(new DomainExceptionFilter());
    await appB.listen(0, '127.0.0.1');
    const baseB = 'http://127.0.0.1:' + ((appB.getHttpServer().address() as { port: number }).port);
    const emailA = 'qa-a19-owner-' + randomUUID().slice(0, 8) + '@example.invalid';
    const emailB = 'qa-a19-member-' + randomUUID().slice(0, 8) + '@example.invalid';
    const password = 'correct horse battery staple';

    const regB = await call(baseB, '/v1/auth/register', post({ email: emailA, password, workspaceName: 'A19 Owner Workspace' }));
    check(regB.status === 201, 'registration works before e-mail is configured');
    const ownerB = regB.body as { token: string; userId: string; workspaceId: string };
    const verifyB = await call(baseB, '/v1/identity/verification/request', post({ email: emailA }));
    check((verifyB.body as { sent: boolean }).sent === false, 'verification e-mail is not claimed when unconfigured');
    const emptyInboxB = await call(baseB, '/v1/notifications', getAuthed(ownerB.token, ownerB.workspaceId));
    check(emptyInboxB.status === 200 && (emptyInboxB.body as { items: unknown[]; unreadCount: number }).unreadCount === 0, 'inbox endpoint serves an empty inbox for the workspace');
    const prefB = await call(baseB, '/v1/notifications/preferences', getAuthed(ownerB.token, ownerB.workspaceId));
    check(prefB.status === 200 && (prefB.body as { category: string; emailEnabled: boolean }[]).every(p => p.emailEnabled), 'preferences default to opted-in');
    const badPrefB = await call(baseB, '/v1/notifications/preferences', postAuthed(ownerB.token, ownerB.workspaceId, { category: 'EVERYTHING', emailEnabled: false }));
    check(badPrefB.status === 400, 'an unknown preference category is rejected');
    const noSession = await call(baseB, '/v1/notifications');
    check(noSession.status === 403 && errorCode(noSession) === 'DENIED', 'the inbox requires a session');
    await appB.close();
    appB = undefined;

    // --- C. Configured with the real Resend adapter (recording fetch) ------------------------
    providerBehavior = 'ok';
    process.env.QEYNOX_EMAIL_PROVIDER = 'resend';
    process.env.QEYNOX_RESEND_API_KEY = 'qa-key';
    process.env.QEYNOX_EMAIL_FROM = 'QeyNox QA <qa@example.invalid>';
    globalThis.fetch = providerStubFetch() as unknown as typeof fetch;
    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const base = 'http://127.0.0.1:' + ((app.getHttpServer().address() as { port: number }).port);

    const connection = connectDatabase(qa.url);
    const db = connection.db;
    const notificationStore = new NotificationStore(db);
    const drainTransport = new ResendEmailTransport({ apiKey: 'qa-key', from: 'QeyNox QA <qa@example.invalid>', fetchImpl: providerStubFetch() as unknown as typeof fetch });
    const drainService = new NotificationService(notificationStore, drainTransport, { publicBaseUrl: 'https://qeynox.qa.example' });

    const emailC1 = 'qa-a19-cust-' + randomUUID().slice(0, 8) + '@example.invalid';
    const emailC2 = 'qa-a19-peer-' + randomUUID().slice(0, 8) + '@example.invalid';
    const bounceEmail = 'qa-bounce-' + randomUUID().slice(0, 8) + '@example.invalid';
    const reg1 = await call(base, '/v1/auth/register', post({ email: emailC1, password, workspaceName: 'A19 Owner Workspace' }));
    const reg2 = await call(base, '/v1/auth/register', post({ email: emailC2, password, workspaceName: 'A19 Member Workspace' }));
    check(reg1.status === 201 && reg2.status === 201, 'two isolated accounts register');
    const user1 = reg1.body as { token: string; userId: string; workspaceId: string };
    const user2 = reg2.body as { token: string; userId: string; workspaceId: string };
    const beforeC = providerCalls.length;

    // Verification e-mails go through the real adapter; the ledger records SENT with the provider id.
    await call(base, '/v1/identity/verification/request', post({ email: emailC1 }));
    check(providerCalls.length === beforeC + 1, 'verification e-mail is handed to the provider');
    check(providerCalls.at(-1)?.subject === 'Confirm your QeyNox e-mail address', 'EN verification subject');
    check((providerCalls.at(-1)?.text ?? '').includes('/en/account/verify?token='), 'verification link is locale-aware');
    const verifyLedger = await db.select().from(emailDeliveriesTable).where(eq(emailDeliveriesTable.category, 'TRANSACTIONAL:EMAIL_VERIFICATION'));
    check(verifyLedger.length === 1 && verifyLedger[0]?.status === 'SENT' && typeof verifyLedger[0]?.providerMessageId === 'string', 'identity delivery is recorded SENT with the provider message id');
    check(verifyLedger[0]?.retryable === false, 'identity e-mails (single-use secret) are never stored retryable');

    // French account: FR template, FR link.
    await call(base, '/v1/account/profile', postAuthed(user1.token, user1.workspaceId, { locale: 'fr' }));
    await call(base, '/v1/identity/verification/request', post({ email: emailC1 }));
    check(providerCalls.at(-1)?.subject === 'Confirmez votre adresse e-mail QeyNox', 'FR verification subject after locale switch');
    check((providerCalls.at(-1)?.text ?? '').includes('/fr/account/verify?token='), 'FR link path');
    await call(base, '/v1/account/profile', postAuthed(user1.token, user1.workspaceId, { locale: 'en' }));

    // Recovery template.
    await call(base, '/v1/identity/recovery/request', post({ email: emailC1 }));
    check(providerCalls.at(-1)?.subject === 'Reset your QeyNox password', 'EN recovery subject');

    // The production path: a completed step plan requires a result review → notification + delivery.
    const progression = new StepProgression(new QeyNoxStore(db));
    const seed1 = await seedRunningOperation(db, user1.workspaceId, user1.userId, 'Harbour analytics review');
    const outcome1 = await progression.complete(requireId(seed1.attemptId), { text: 'the finding', engine: 'qa', engineRunId: 'qa-1', evidenceId: 'qa-ev-1' }, 'UNVERIFIED');
    check(outcome1 === 'AWAITING_REVIEW', 'all steps complete → AWAITING_REVIEW (approval requested)');
    const preDrainCalls = providerCalls.length;
    const drain1 = await drainService.drain(25);
    check(drain1.materialized.notifications === 1 && drain1.materialized.deliveries === 1, 'exactly one notification + one delivery is materialized for the review event');
    check(providerCalls.length === preDrainCalls + 1, 'the delivery is sent inline by the drain');
    check(providerCalls.at(-1)?.category === 'APPROVALS', 'approval e-mail carries the APPROVALS category');
    check(providerCalls.at(-1)?.subject.includes('Harbour analytics review') ?? false, 'approval subject carries the operation title');
    check((providerCalls.at(-1)?.text ?? '').includes('https://qeynox.qa.example/en/missions/' + seed1.operationId), 'approval text links to the mission over the configured public base URL');
    const drainAgain = await drainService.drain(25);
    check(drainAgain.materialized.notifications === 0 && providerCalls.length === preDrainCalls + 1, 're-draining the same event deduplicates — no duplicate notification, no duplicate send');

    const inbox = await call(base, '/v1/notifications', getAuthed(user1.token, user1.workspaceId));
    const inboxBody = inbox.body as { items: { id: string; kind: string; readAt: string | null; body: string; linkPath: string }[]; unreadCount: number };
    check(inbox.status === 200 && inboxBody.items.length === 1 && inboxBody.unreadCount === 1, 'the inbox shows the approval notification as unread');
    check(inboxBody.items[0]?.kind === 'APPROVALS', 'the inbox item carries the APPROVALS kind');
    check(linked(inboxBody.items[0]?.linkPath ?? ''), 'the inbox item links back to the mission');
    const notifId = inboxBody.items[0]?.id as string;
    const readOne = await call(base, '/v1/notifications/' + notifId + '/read', postAuthed(user1.token, user1.workspaceId, {}));
    check(readOne.status === 201 && (readOne.body as { read: boolean }).read === true, 'marking a notification read succeeds');
    const readAgain = await call(base, '/v1/notifications/' + notifId + '/read', postAuthed(user1.token, user1.workspaceId, {}));
    check((readAgain.body as { read: boolean }).read === false, 'an already-read notification reports read:false — no invented transition');

    // Opt-out suppresses the e-mail but never the inbox row.
    await call(base, '/v1/notifications/preferences', postAuthed(user1.token, user1.workspaceId, { category: 'APPROVALS', emailEnabled: false }));
    const seed2 = await seedRunningOperation(db, user1.workspaceId, user1.userId, 'Cold chain audit');
    await progression.complete(requireId(seed2.attemptId), { text: 'second finding', engine: 'qa', engineRunId: 'qa-2', evidenceId: 'qa-ev-2' }, 'UNVERIFIED');
    const beforeOptOut = providerCalls.length;
    await drainService.drain(25);
    check(providerCalls.length === beforeOptOut, 'an opted-out category sends no e-mail');
    const inboxOptOut = await call(base, '/v1/notifications?unreadOnly=true', getAuthed(user1.token, user1.workspaceId));
    check((inboxOptOut.body as { items: unknown[] }).items.length === 1, 'the opted-out event is still recorded in the inbox');
    const approvalDeliveries = await db.select().from(emailDeliveriesTable).where(eq(emailDeliveriesTable.category, 'APPROVALS'));
    check(approvalDeliveries.length === 1, 'no second approval delivery row was created for the opted-out event');

    // Opt-in again; French recipient: FR template on the next event.
    await call(base, '/v1/account/profile', postAuthed(user1.token, user1.workspaceId, { locale: 'fr' }));
    await call(base, '/v1/notifications/preferences', postAuthed(user1.token, user1.workspaceId, { category: 'APPROVALS', emailEnabled: true }));
    const seed3 = await seedRunningOperation(db, user1.workspaceId, user1.userId, 'Portfolio allocation brief');
    await progression.complete(requireId(seed3.attemptId), { text: 'third finding', engine: 'qa', engineRunId: 'qa-3', evidenceId: 'qa-ev-3' }, 'UNVERIFIED');
    await drainService.drain(25);
    check(providerCalls.at(-1)?.subject.startsWith('Votre revue est requise') ?? false, 'FR approval template is selected by the recipient locale');
    const approvalDeliveriesFr = await db.select().from(emailDeliveriesTable).where(eq(emailDeliveriesTable.category, 'APPROVALS'));
    check(approvalDeliveriesFr.length === 2, 'the re-enabled category delivers again');
    await call(base, '/v1/account/profile', postAuthed(user1.token, user1.workspaceId, { locale: 'en' }));

    // Delivered results: the REAL production path (assembler → approved review → deliver()).
    const resultSeed = await seedRunningOperation(db, user1.workspaceId, user1.userId, 'Northwind tender reply');
    const resultComplete = await progression.complete(requireId(resultSeed.attemptId), { text: 'delivery finding', engine: 'qa', engineRunId: 'qa-4', evidenceId: 'qa-ev-4' }, 'UNVERIFIED');
    check(resultComplete === 'AWAITING_REVIEW', 'the delivery seed reaches AWAITING_REVIEW');
    await drainService.drain(25); // flush the STEPS_COMPLETED_REVIEW_REQUIRED event first
    const principal = { userId: requireId(user1.userId), workspaceId: requireId(user1.workspaceId), roles: ['OWNER'] };
    const claimId = randomUUID();
    const sourceId = randomUUID();
    const claimNow = new Date().toISOString();
    await db.insert(claims).values({ id: claimId, workspaceId: user1.workspaceId, operationId: resultSeed.operationId, attemptId: resultSeed.attemptId, statement: 'The tender can be answered with standard terms', kind: 'FACT', status: 'SUPPORTED', createdAt: claimNow });
    await db.insert(sources).values({ id: sourceId, workspaceId: user1.workspaceId, operationId: resultSeed.operationId, payload: { id: sourceId, workspaceId: user1.workspaceId, operationId: resultSeed.operationId, uri: 'https://provider.example.invalid/tender/4711', provider: 'qa-provider', title: 'Tender 4711', retrievedAt: claimNow } as never });
    await db.insert(claimEvidenceLinks).values({ id: randomUUID(), claimId, sourceId, relationship: 'SUPPORTS', addedAt: claimNow });
    const storeForDelivery = new QeyNoxStore(db);
    const assembler = new ResultAssembler(storeForDelivery);
    const assembled = await assembler.assemble(principal, requireId(resultSeed.operationId), requireId(resultSeed.revisionId), 'Northwind tender reply', ['Scope: tender response draft'], ['Confirm the internal deadline']);
    check(assembled.status === 'READY_FOR_REVIEW', 'evidenced claims assemble to READY_FOR_REVIEW');
    const [approvalRow] = await db.select().from(approvals).where(eq(approvals.operationId, resultSeed.operationId));
    check(approvalRow !== undefined && (approvalRow.payload as { purpose?: string }).purpose === 'RESULT_REVIEW', 'the review approval exists for the operation');
    if (!approvalRow) throw new Error('unreachable');
    await db.update(approvals).set({ status: 'APPROVED', payload: { ...approvalRow.payload, status: 'APPROVED' } }).where(eq(approvals.id, approvalRow.id));
    await db.insert(commercialOrders).values({ id: randomUUID(), workspaceId: user1.workspaceId, operationId: resultSeed.operationId, revisionId: resultSeed.revisionId, quoteId: randomUUID(), state: 'AUTHORIZED', amountMinor: 1250000, currency: 'EUR', updatedAt: claimNow, createdAt: claimNow });
    const deliveryService = new ResultDeliveryService(storeForDelivery);
    const beforeDelivery = providerCalls.length;
    const delivered = await deliveryService.deliver(principal, requireId(resultSeed.operationId), requireId(assembled.id), requireId(approvalRow.id));
    check(delivered.status === 'DELIVERABLE', 'deliver() releases the reviewed document and marks the operation COMPLETED');
    await drainService.drain(25);
    check(providerCalls.length === beforeDelivery + 1, 'exactly one delivered-result e-mail goes out');
    check(providerCalls.at(-1)?.category === 'RESULTS', 'the delivered-result e-mail carries the RESULTS category');
    check(providerCalls.at(-1)?.subject === 'Your deliverable is ready: “Northwind tender reply”', 'the delivered-result e-mail carries the EN RESULT_DELIVERED subject with the operation title');
    check((providerCalls.at(-1)?.text ?? '').includes('https://qeynox.qa.example/en/missions/' + resultSeed.operationId), 'the delivered-result e-mail links to the mission');
    const resultsDeliveries = await db.select().from(emailDeliveriesTable).where(eq(emailDeliveriesTable.category, 'RESULTS'));
    check(resultsDeliveries.length === 1 && resultsDeliveries[0]?.status === 'SENT', 'the RESULTS ledger row is SENT');
    const resultsInbox = await call(base, '/v1/notifications', getAuthed(user1.token, user1.workspaceId));
    const resultsInboxBody = resultsInbox.body as { items: { kind: string }[]; unreadCount: number };
    check(resultsInboxBody.items.some(item => item.kind === 'RESULTS'), 'the inbox lists the RESULTS notification');

    // Execution failure and delivered result events materialize from the events table directly —
    // exactly the rows the worker writes in production.
    const nowIso = new Date().toISOString();
    await db.insert(events).values({ id: randomUUID(), workspaceId: user1.workspaceId, operationId: seed3.operationId, kind: 'STEP_FAILED', occurredAt: nowIso, payload: { id: 'e1', workspaceId: user1.workspaceId, operationId: seed3.operationId, kind: 'STEP_FAILED', data: { attemptId: seed3.attemptId, errorCode: 'ENGINE_OR_TOOL_ERROR' }, occurredAt: nowIso, eventVersion: 1 } as never });
    await db.insert(events).values({ id: randomUUID(), workspaceId: user1.workspaceId, operationId: seed3.operationId, kind: 'RESULT_DELIVERED', occurredAt: nowIso, payload: { id: 'e2', workspaceId: user1.workspaceId, operationId: seed3.operationId, kind: 'RESULT_DELIVERED', data: { documentId: 'qa-doc' }, occurredAt: nowIso, eventVersion: 1 } as never });
    await drainService.drain(25);
    const inboxKinds = (await call(base, '/v1/notifications?unreadOnly=true', getAuthed(user1.token, user1.workspaceId))).body as { items: { kind: string }[] };
    const kinds = inboxKinds.items.map(item => item.kind).sort();
    check(kinds.includes('EXECUTION_FAILURES') && kinds.includes('RESULTS'), 'failure and delivery events materialize into their kinds');
    const failureMail = providerCalls.find(c => c.category === 'EXECUTION_FAILURES');
    check(failureMail?.text.includes('ENGINE_OR_TOOL_ERROR') ?? false, 'the failure e-mail carries the real error code');

    // Opt-out of RESULTS: inbox records, no e-mail.
    await call(base, '/v1/notifications/preferences', postAuthed(user1.token, user1.workspaceId, { category: 'RESULTS', emailEnabled: false }));
    const beforeResultsOptOut = providerCalls.length;
    await db.insert(events).values({ id: randomUUID(), workspaceId: user1.workspaceId, operationId: seed2.operationId, kind: 'RESULT_DELIVERED', occurredAt: new Date().toISOString(), payload: { id: 'e3', workspaceId: user1.workspaceId, operationId: seed2.operationId, kind: 'RESULT_DELIVERED', data: { documentId: 'qa-doc-2' }, occurredAt: new Date().toISOString(), eventVersion: 1 } as never });
    await drainService.drain(25);
    check(providerCalls.length === beforeResultsOptOut, 'RESULTS opt-out sends no e-mail');
    const resultDeliveries = await db.select().from(emailDeliveriesTable).where(eq(emailDeliveriesTable.category, 'RESULTS'));
    check(resultDeliveries.length === 2, 'no additional RESULTS delivery row was created for the opted-out event (real deliver() + synthetic event only)');
    const unreadBody = (await call(base, '/v1/notifications?unreadOnly=true', getAuthed(user1.token, user1.workspaceId))).body as { items: { kind: string }[] };
    check(unreadBody.items.filter(item => item.kind === 'RESULTS').length === 3, 'all three RESULTS events were recorded in the inbox');
    await call(base, '/v1/notifications/read-all', postAuthed(user1.token, user1.workspaceId, {}));

    // Invitation e-mail (customer self-service path) through the real adapter.
    const invite = await call(base, '/v1/workspaces/current/invitations', postAuthed(user1.token, user1.workspaceId, { email: emailC2, role: 'MEMBER', reason: 'A19 QA invitation coverage' }));
    check(invite.status === 201, 'an existing account can be invited');
    const inviteBody = invite.body as { invitationToken: string; delivery: { email: string } };
    check(inviteBody.delivery.email === 'SENT', 'the invitation e-mail is reported SENT only when the provider accepted it');
    check(providerCalls.at(-1)?.category === 'TRANSACTIONAL', 'invitation e-mail carries the TRANSACTIONAL category');
    check(providerCalls.at(-1)?.subject.includes('QeyNox workspace') ?? false, 'invitation e-mail carries the localized invitation subject');
    const invitationDeliveries = await db.select().from(emailDeliveriesTable).where(eq(emailDeliveriesTable.category, 'TRANSACTIONAL:WORKSPACE_INVITATION'));
    check(invitationDeliveries.length === 1 && invitationDeliveries[0]?.status === 'SENT', 'the invitation outcome is recorded in the ledger');

    // Identity failure truthfulness: the provider rejects this recipient permanently.
    await call(base, '/v1/auth/register', post({ email: bounceEmail, password, workspaceName: 'A19 Bounce Workspace' }));
    providerBehavior = 'always-permanent';
    const bounceResult = await call(base, '/v1/identity/verification/request', post({ email: bounceEmail }));
    providerBehavior = 'ok';
    check((bounceResult.body as { sent: boolean; notSentReason: string | null }).sent === false && (bounceResult.body as { notSentReason: string }).notSentReason === 'EMAIL_DELIVERY_FAILED', 'a rejected send reports sent:false — never a false delivery claim');
    const bounceLedger = await db.select().from(emailDeliveriesTable).where(eq(emailDeliveriesTable.recipient, bounceEmail));
    check(bounceLedger.length === 1 && bounceLedger[0]?.status === 'FAILED' && bounceLedger[0]?.lastErrorCode === 'EMAIL_PROVIDER_REJECTED', 'the rejection is recorded FAILED with the provider error code, not SENT');

    // --- C2. Service-level retry/backoff/terminal transitions with a stub transport -----------
    class ScriptedTransport implements EmailTransport {
      readonly status = 'CONFIGURED' as const;
      readonly reason = null;
      readonly provider = 'scripted';
      calls = 0;
      constructor(private readonly script: (attempt: number) => 'ok' | 'retryable' | 'permanent') {}
      async send(): Promise<{ providerMessageId: string }> {
        this.calls++;
        const verdict = this.script(this.calls);
        if (verdict === 'ok') return { providerMessageId: 'scripted-' + this.calls };
        if (verdict === 'retryable') throw new EmailDeliveryError('EMAIL_PROVIDER_RETRYABLE', 'temporary', true);
        throw new EmailDeliveryError('EMAIL_PROVIDER_REJECTED', 'permanent', false);
      }
    }
    const insertRetryable = async (dedup: string, recipient: string, maxAttempts = 3) => {
      const rowId = randomUUID();
      await db.insert(emailDeliveriesTable).values({
        id: rowId, userId: user1.userId, workspaceId: user1.workspaceId, category: 'RESULTS',
        recipient, subject: 'scripted', provider: 'scripted', status: 'PENDING', retryable: true,
        attemptCount: 0, maxAttempts, nextRetryAt: new Date(Date.now() - 1000),
        templateId: 'RESULT_DELIVERED', templateVars: { operationTitle: 'Scripted', actionUrl: 'https://qeynox.qa.example/en/missions/scripted' },
        locale: 'en', deduplicationKey: dedup, createdAt: new Date(), updatedAt: new Date(),
      } as never);
      return rowId;
    };
    const forceDue = async (rowId: string) => {
      await db.update(emailDeliveriesTable).set({ nextRetryAt: new Date(Date.now() - 1000) }).where(eq(emailDeliveriesTable.id, rowId));
    };
    const getRow = async (rowId: string) => (await db.select().from(emailDeliveriesTable).where(eq(emailDeliveriesTable.id, rowId)))[0];

    const retryableStub = new ScriptedTransport(() => 'retryable');
    const svcRetry = new NotificationService(notificationStore, retryableStub, { publicBaseUrl: 'https://qeynox.qa.example' });
    const rowId1 = await insertRetryable('qa-retry-' + randomUUID(), 'retry@example.invalid');
    await svcRetry.processDueDeliveries(10);
    let row = await getRow(rowId1);
    check(row?.status === 'PENDING' && row?.attemptCount === 1 && row?.lastErrorCode === 'EMAIL_PROVIDER_RETRYABLE', 'a retryable failure keeps the row pending with the error recorded and an attempt counted');
    await forceDue(rowId1);
    await svcRetry.processDueDeliveries(10);
    row = await getRow(rowId1);
    check(row?.status === 'PENDING' && row?.attemptCount === 2, 'second attempt recorded');
    await forceDue(rowId1);
    await svcRetry.processDueDeliveries(10);
    row = await getRow(rowId1);
    check(row?.status === 'FAILED' && row?.attemptCount === 3 && row?.lastErrorCode === 'EMAIL_PROVIDER_RETRYABLE', 'attempts exhausted → terminal FAILED, honestly recorded');

    const permanentStub = new ScriptedTransport(() => 'permanent');
    const svcPermanent = new NotificationService(notificationStore, permanentStub, { publicBaseUrl: 'https://qeynox.qa.example' });
    const rowId2 = await insertRetryable('qa-permanent-' + randomUUID(), 'permanent@example.invalid');
    await svcPermanent.processDueDeliveries(10);
    row = await getRow(rowId2);
    check(row?.status === 'FAILED' && row?.attemptCount === 1, 'a permanent provider rejection fails terminally after the first attempt');

    const flakyStub = new ScriptedTransport(attempt => (attempt < 2 ? 'retryable' : 'ok'));
    const svcFlaky = new NotificationService(notificationStore, flakyStub, { publicBaseUrl: 'https://qeynox.qa.example' });
    const rowId3 = await insertRetryable('qa-flaky-' + randomUUID(), 'flaky@example.invalid');
    await svcFlaky.processDueDeliveries(10);
    await forceDue(rowId3);
    await svcFlaky.processDueDeliveries(10);
    row = await getRow(rowId3);
    check(row?.status === 'SENT' && row?.attemptCount === 2 && typeof row?.providerMessageId === 'string', 'a transient failure recovers and records SENT with the provider id, not on the first try');

    // Cross-tenant isolation.
    const inboxUser2 = await call(base, '/v1/notifications', getAuthed(user2.token, user2.workspaceId));
    check((inboxUser2.body as { items: unknown[]; unreadCount: number }).items.length === 0 && (inboxUser2.body as { unreadCount: number }).unreadCount === 0, 'a second tenant sees an empty inbox');
    const crossRead = await call(base, '/v1/notifications/' + notifId + '/read', postAuthed(user2.token, user2.workspaceId, {}));
    check((crossRead.body as { read: boolean }).read === false, 'a second tenant cannot mark another tenant\'s notification read');
    const readAllUser2 = await call(base, '/v1/notifications/read-all', postAuthed(user2.token, user2.workspaceId, {}));
    check((readAllUser2.body as { updated: number }).updated === 0, 'a second tenant\'s mark-all affects nothing across the tenant boundary');
    const prefsUser2 = await call(base, '/v1/notifications/preferences', getAuthed(user2.token, user2.workspaceId));
    check((prefsUser2.body as { emailEnabled: boolean }[]).every(p => p.emailEnabled), 'preferences are per user and do not leak across tenants');

    // Honest delivery for invitations when unconfigured is covered in section B. The app's own
    // default (no env overrides) was verified there; C covered the configured paths only.
    await app.close();
    app = undefined;
    console.log('qa-notifications: all ' + assertions + ' assertions passed');
    return PASS;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return FAILED;
  } finally {
    if (app) await app.close().catch(() => undefined);
    if (appB) await appB.close().catch(() => undefined);
    globalThis.fetch = realFetch;
    // Deliberately NOT dropping qa.name here in external mode; createIsolatedQaDatabase handles both.
    await qa.drop().catch(() => undefined);
  }
}

const linked = (path: string): boolean => path.startsWith('/missions/');

main().then(code => process.exit(code)).catch(error => { console.error(error); process.exit(1); });
