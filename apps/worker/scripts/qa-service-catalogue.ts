/**
 * MISSION A13 — service catalogue and customer ordering QA.
 *
 * Two independent halves, deliberately separated:
 *
 *  PART 1 — CONTRACTS (pure, always runnable)
 *   - the World Bank typed request schema and the envelope discriminated union accept the reviewed
 *     shape and reject every malformed or out-of-scope variant;
 *   - the contract registry is fail-closed: an offer with no registered contract is never orderable,
 *     and a contract whose capability set disagrees with the offer is refused;
 *   - service configuration parsing fails closed on malformed sections.
 *
 *  PART 2 — CATALOGUE + ORDER FLOW (isolated disposable database)
 *   - an empty deployment serves an honest empty catalogue;
 *   - after the reviewed operator configuration is applied, ACTIVE offers are published with their
 *     real scope/price/tax/terms, joined with real capability availability;
 *   - availability blockers are named; nothing reports executable without an operational runtime;
 *   - a deployment probe echoes World Bank switches as booleans, never values;
 *   - a customer can request the published service through the registered contract; the produced
 *     operation is READY, quote = the configured (free) offer, acceptance authorizes execution;
 *   - readiness gating: without an attested runtime the offer is listed but never executable, and
 *     the request is still rejected by the contract path if the capability is unconfigured.
 *
 * PART 2 refuses to run without QEYNOX_QA_DATABASE_URL. It NEVER substitutes fixtures for the
 * provider and never reports a contract-only run as integration evidence.
 *
 * Run: pnpm --filter @qeynox/worker qa:service-catalogue
 * Exit: 0 PASS · 3 BLOCKED (prerequisite unavailable) · 1 FAILED
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import {
  QeyNoxStore, connectDatabase, runMigrations,
  identityMemberships, identityUsers, identityWorkspaces, offers,
} from '@qeynox/persistence';
import {
  CommerceService, ConfigurationService, PlanningService, ServiceCatalogueService,
  ServiceContractRegistry, WorldBankResearchContract,
  makeRuntimeReadiness, parseWorldBankServiceConfig, resolveContract, validateServiceConfiguration,
  type ServiceRequestContract,
} from '@qeynox/application';
import { DomainError, type ID, type Principal } from '@qeynox/domain';
import {
  serviceRequestEnvelopeSchema, serviceListSchema, serviceDetailSchema,
  SERVICE_CONTRACT_WORLD_BANK,
} from '@qeynox/contracts';
import { createIsolatedQaDatabase } from '../../api/scripts/qa-isolated-database';

const PASS = 0;
const FAILED = 1;
const BLOCKED = 3;

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
async function expectError(code: string, run: () => Promise<unknown> | unknown, label: string): Promise<void> {
  assertions++;
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code + ': ' + error.message : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}
class BlockedSignal extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'BlockedSignal'; }
}
function blocked(reason: string): never { throw new BlockedSignal(reason); }

const templateUrl = new URL('../../../infra/operator/a03-economic-research.json', import.meta.url);
const template = JSON.parse(readFileSync(templateUrl, 'utf8')) as {
  idempotencyKey: string; dryRun: boolean;
  service: { capabilityId: string; offerId: string; budgetPolicyId: string; allowedCountries: string[]; allowedIndicators: string[]; maximumObservations: number };
  entries: { domain: string }[];
};
const entryOf = (domain: string): Record<string, unknown> => {
  const entry = template.entries.find(item => item.domain === domain);
  if (!entry) throw new Error('template entry missing for domain ' + domain);
  return entry as unknown as Record<string, unknown>;
};
const capabilityEntry = entryOf('BUSINESS_CAPABILITY') as unknown as { id?: string; maximumSteps: number; maximumToolCalls: number; name: string };
const offerEntry = entryOf('RAAS_OFFER') as unknown as { offerId: string; capabilityIds: string[]; scope: string[] };
const parsedService = parseWorldBankServiceConfig(template.service);

/** A fully operational runtime: only used to prove the service is not permanently BLOCKED by design. */
const OPERATIONAL_RUNTIME = makeRuntimeReadiness({
  engineConfigured: true, engineVerifiedLive: true, engineAttested: true, engineEvidence: 'qa-a13',
  orchestratorConfigured: true, orchestratorVerifiedLive: true, orchestratorAttested: true, orchestratorEvidence: 'qa-a13',
});

const envelopeInput = { objective: 'Assess how GDP per capita evolved in Morocco across the last three published years', country: 'MAR', indicator: 'NY.GDP.PCAP.CD' };

// =============================================================================================
// PART 1 — pure contract and registry checks (no database)
// =============================================================================================
function partOne(): void {
  console.log('— PART 1: typed request contract and registry —');
  const before = assertions;

  // --- envelope acceptance -----------------------------------------------------------------
  const good = serviceRequestEnvelopeSchema.safeParse({ service: SERVICE_CONTRACT_WORLD_BANK, input: envelopeInput });
  check(good.success, 'the reviewed World Bank envelope parses');
  const withConstraints = serviceRequestEnvelopeSchema.safeParse({ service: SERVICE_CONTRACT_WORLD_BANK, input: { ...envelopeInput, constraints: { mostRecent: 2, compareIndicators: ['NY.GDP.MKTP.KD.ZG'], includeInterpretation: true, note: 'flag freshness lags' } } });
  check(withConstraints.success, 'constraints within the reviewed bounds parse');

  // --- envelope rejection ------------------------------------------------------------------
  const rejections: Array<[string, unknown]> = [
    ['unknown discriminator', { service: 'generic-order@1', input: envelopeInput }],
    ['missing discriminator', { input: envelopeInput }],
    ['missing input', { service: SERVICE_CONTRACT_WORLD_BANK }],
    ['objective too short', { service: SERVICE_CONTRACT_WORLD_BANK, input: { ...envelopeInput, objective: 'too short' } }],
    ['objective too long', { service: SERVICE_CONTRACT_WORLD_BANK, input: { ...envelopeInput, objective: 'x'.repeat(5001) } }],
    ['country name instead of code', { service: SERVICE_CONTRACT_WORLD_BANK, input: { ...envelopeInput, country: 'Morocco' } }],
    ['country with digits', { service: SERVICE_CONTRACT_WORLD_BANK, input: { ...envelopeInput, country: 'M4R' } }],
    ['indicator without dotted shape', { service: SERVICE_CONTRACT_WORLD_BANK, input: { ...envelopeInput, indicator: 'GDP' } }],
    ['two comparison indicators plus one more', { service: SERVICE_CONTRACT_WORLD_BANK, input: { ...envelopeInput, constraints: { compareIndicators: ['NY.GDP.MKTP.CD', 'SP.POP.TOTL', 'SL.UEM.TOTL.ZS'] } } }],
    ['zero observations', { service: SERVICE_CONTRACT_WORLD_BANK, input: { ...envelopeInput, constraints: { mostRecent: 0 } } }],
    ['six observations', { service: SERVICE_CONTRACT_WORLD_BANK, input: { ...envelopeInput, constraints: { mostRecent: 6 } } }],
    ['implausible year', { service: SERVICE_CONTRACT_WORLD_BANK, input: { ...envelopeInput, constraints: { minObservationYear: 1800 } } }],
    ['note too long', { service: SERVICE_CONTRACT_WORLD_BANK, input: { ...envelopeInput, constraints: { note: 'n'.repeat(501) } } }],
  ];
  for (const [label, envelope] of rejections) {
    check(!serviceRequestEnvelopeSchema.safeParse(envelope).success, 'envelope rejected: ' + label);
  }

  // --- service configuration parsing fails closed -------------------------------------------
  check(parsedService.offerId === offerEntry.offerId, 'the service section binds the reviewed offer');
  let rejected = false;
  try { parseWorldBankServiceConfig({ capabilityId: template.service.capabilityId, offerId: template.service.offerId }); } catch { rejected = true; }
  check(rejected, 'a service section without a budgetPolicyId is rejected');
  rejected = false;
  try { parseWorldBankServiceConfig({ ...template.service, allowedIndicators: ['not an indicator'] }); } catch { rejected = true; }
  check(rejected, 'a malformed allowedIndicator pattern is rejected');

  // --- registry fail-closed behaviour --------------------------------------------------------
  const offerCapabilities = [...(offerEntry.capabilityIds ?? [])];
  check(offerCapabilities.length > 0, 'the offer covers at least one capability');
  const empty = resolveContract(new ServiceContractRegistry(), offerEntry.offerId as string, offerCapabilities);
  check(empty.contract === null && empty.reason === 'SERVICE_NOT_CONFIGURED', 'an offer with no registered contract is never orderable');
  const nullRegistry = resolveContract(null, offerEntry.offerId as string, offerCapabilities);
  check(nullRegistry.contract === null && nullRegistry.reason === 'SERVICE_NOT_CONFIGURED', 'a deployment without a registry refuses ordering');

  const fakeContract: ServiceRequestContract = {
    key: SERVICE_CONTRACT_WORLD_BANK,
    offerId: offerEntry.offerId as string,
    capabilityIds: ['some-other-capability'],
    requestSchema: serviceRequestEnvelopeSchema,
    create: () => Promise.reject(new DomainError('UNEXPECTED_EXECUTION_ERROR', 'never called')),
  };
  const mismatch = resolveContract(new ServiceContractRegistry([fakeContract]), offerEntry.offerId as string, offerCapabilities);
  check(mismatch.contract === null && mismatch.reason === 'SERVICE_NOT_CONFIGURED', 'a contract whose capabilities disagree with the offer is refused, not guessed');

  console.log('  PART 1 PASSED: ' + (assertions - before) + ' assertions');
}

// =============================================================================================
// PART 2 — catalogue visibility and the order flow against an isolated database
// =============================================================================================
async function partTwo(): Promise<'PASSED' | 'BLOCKED'> {
  console.log('— PART 2: catalogue, availability, order flow —');
  if (!process.env.QEYNOX_QA_DATABASE_URL) {
    console.log('BLOCKED: PART 2 not run — QEYNOX_QA_DATABASE_URL is not set. A contracts-only run is not integration evidence.');
    return 'BLOCKED';
  }

  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let connection: ReturnType<typeof connectDatabase> | undefined;
  try {
    const migration = await runMigrations(qa.url);
    check(migration.total > 0, 'disposable QA database migrated');
    connection = connectDatabase(qa.url);
    const db = connection.db;
    const store = new QeyNoxStore(db);

    // --- principals -------------------------------------------------------------------------
    const ownerId = randomUUID(), memberId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(identityUsers).values([
      { id: ownerId, email: 'qa-a13-owner-' + ownerId + '@example.invalid' },
      { id: memberId, email: 'qa-a13-member-' + memberId + '@example.invalid' },
    ]);
    await db.insert(identityWorkspaces).values([{ id: workspaceId, name: 'QA A13 Workspace', createdBy: ownerId }]);
    await db.insert(identityMemberships).values([
      { id: randomUUID(), userId: ownerId, workspaceId, role: 'OWNER', status: 'ACTIVE' },
      { id: randomUUID(), userId: memberId, workspaceId, role: 'MEMBER', status: 'ACTIVE' },
    ]);
    const owner: Principal = { userId: ownerId as ID, workspaceId: workspaceId as ID, roles: ['OWNER'] };
    const member: Principal = { userId: memberId as ID, workspaceId: workspaceId as ID, roles: ['MEMBER'] };

    process.env.QEYNOX_OPERATOR_USER_IDS = ownerId;
    // P22 BIS: provider readiness is configured explicitly inside the isolated QA environment —
    // World Bank switch, egress attestation and host allowlist — never inherited from ambient shell
    // state, so the availability computation below is deterministic.
    process.env.QEYNOX_WORLD_BANK_ENABLED = 'true';
    process.env.QEYNOX_NETWORK_POLICY_ATTESTED = 'true';
    process.env.QEYNOX_EGRESS_ALLOWED_HOSTS = 'api.worldbank.org';

    // --- 1. An empty deployment serves an honest empty catalogue ------------------------------
    const emptyCatalogue = new ServiceCatalogueService(store, undefined, null);
    const emptyList = await emptyCatalogue.list(member);
    check(emptyList.length === 0, 'an environment with no published offers shows none — nothing is invented');
    check(serviceListSchema.safeParse(emptyList).success, 'the empty catalogue still satisfies the wire contract');

    // --- 2. Apply the reviewed operator configuration -----------------------------------------
    const configuration = new ConfigurationService(store);
    await configuration.apply(owner, { idempotencyKey: template.idempotencyKey, entries: [...template.entries] } as never);
    const [offerRow] = await db.select().from(offers).where(eq(offers.id, offerEntry.offerId as string));
    check(offerRow?.status === 'ACTIVE', 'the RaaS offer is published as ACTIVE by the operator apply flow');

    const failClosed = new ServiceCatalogueService(store, undefined, null);
    const listed = await failClosed.list(member);
    check(listed.length === 1, 'the catalogue publishes exactly the ACTIVE operator offer');
    const summary = listed[0]!;
    check(summary.offerId === offerEntry.offerId, 'the catalogue entry names the published offer');
    check(summary.label.length > 0 && summary.amountMinor === 0, 'the free offer renders with the configured (zero) price');
    check(summary.isExplicitlyFree === true, 'the zero price is explicitly free — never silent');
    check(summary.taxPolicy === 'CONFIGURED', 'the tax treatment is CONFIGURED');
    check(summary.scope.length >= 3, 'the scope is the operator scope, not a marketing stub');
    check(summary.scope.includes(offerEntry.scope[0]!), 'the scope matches the published offer verbatim');
    check(summary.exclusions.includes('No forecast or projection'), 'exclusions from the published offer are shown');
    check(summary.termsVersion === '2026-11-a03', 'the published terms version is shown');
    check(summary.regions.includes('GLOBAL') && summary.locales.includes('fr') && summary.locales.includes('en'), 'regions and locales come from the offer');
    check(summary.capabilityIds.length === 1, 'the offer names exactly the reviewed capability');
    check(summary.availability.isExecutable === false, 'without an attested runtime nothing is executable');
    check(summary.availability.blockers.includes('RUNTIME_NOT_OPERATIONAL'), 'the runtime blocker is named');
    check(summary.requestable === false && summary.unavailableReason === 'SERVICE_NOT_CONFIGURED', 'no registered contract means not orderable — never a guess');
    check(!serviceDetailSchema.safeParse({}).success, 'the detail contract rejects an empty shape');

    const detail = await failClosed.detail(member, offerEntry.offerId as string);
    check(detail !== null, 'detail resolves the published offer');
    check(detail!.capabilities.length === 1, 'detail lists the capability used by the service');
    check(detail!.capabilities[0]!.operationalState !== 'OPERATIONAL', 'the capability is not OPERATIONAL without an attested runtime');
    check(detail!.deployment === null, 'no deployment probe without a contract registry — nothing invented');
    check(serviceDetailSchema.safeParse(detail).success, 'the detail satisfies the wire contract');
    const missing = await failClosed.detail(member, 'offer-does-not-exist');
    check(missing === null, 'an unpublished offer id resolves to null (404), never to a fabricated page');

    // --- 3. The reviewed runtime unblocks execution (not the catalogue itself) ---------------
    const runtimeBacked = new ServiceCatalogueService(store, () => OPERATIONAL_RUNTIME, null);
    const ready = (await runtimeBacked.list(member))[0]!;
    check(ready.availability.isExecutable === true, 'with an attested runtime and the applied configuration the offer is executable');
    check(ready.availability.blockers.length === 0, 'no blockers remain for the fully configured service');

    // --- 4. A deployment registers the World Bank contract from the operator service file -----
    const planning = new PlanningService(store);
    const probe = () => ({ worldBankEnabled: process.env.QEYNOX_WORLD_BANK_ENABLED === 'true', egressAttested: process.env.QEYNOX_NETWORK_POLICY_ATTESTED === 'true' });
    const contract = new WorldBankResearchContract(store, planning, parsedService, () => OPERATIONAL_RUNTIME);
    const registry = new ServiceContractRegistry([contract]);
    const ordered = new ServiceCatalogueService(store, () => OPERATIONAL_RUNTIME, registry, key => key === SERVICE_CONTRACT_WORLD_BANK ? probe() : null);
    const orderable = (await ordered.list(member))[0]!;
    check(orderable.requestable === true && orderable.contractKey === SERVICE_CONTRACT_WORLD_BANK, 'the registered contract makes the offer orderable');
    check(orderable.unavailableReason === null, 'a requestable offer carries no unavailable reason');
    const orderableDetail = await ordered.detail(member, offerEntry.offerId as string);
    check(orderableDetail?.deployment?.worldBankEnabled === true && orderableDetail.deployment.egressAttested === true, 'the deployment probe echoes the provider switches as booleans');
    check(orderableDetail!.contractKey === SERVICE_CONTRACT_WORLD_BANK, 'the detail names the registered contract');

    // --- 5. The request creates the operation and the bounded plan ---------------------------
    const created = await contract.create(owner, { objective: envelopeInput.objective, country: 'MAR', indicator: 'NY.GDP.PCAP.CD' });
    check(created.stepCount === 1, 'a plain request produces one bounded research step');
    check(/^[0-9a-f]{8}-[0-9a-f]+$/.test(created.fingerprint), 'the request fingerprint is the deterministic digest the customer approves: ' + created.fingerprint);
    const operation = await store.getOperation(owner, created.operationId as ID);
    check(operation.status === 'READY', 'the operation awaits explicit approval, never auto-executed');
    check(operation.currentRevisionId === created.revisionId, 'the plan revision is the created revision');
    const memberView = await store.getOperation(member, created.operationId as ID);
    check(memberView.id === created.operationId, 'a workspace peer reads the operation — operations are workspace-scoped, not user-scoped');

    // Tenancy: a principal outside the workspace cannot see the created operation.
    const outsiderId = randomUUID(); const otherWorkspaceId = randomUUID();
    await db.insert(identityUsers).values([{ id: outsiderId, email: 'qa-a13-outsider-' + outsiderId + '@example.invalid' }]);
    await db.insert(identityWorkspaces).values([{ id: otherWorkspaceId, name: 'QA A13 Other Workspace', createdBy: outsiderId }]);
    await db.insert(identityMemberships).values([{ id: randomUUID(), userId: outsiderId, workspaceId: otherWorkspaceId, role: 'OWNER', status: 'ACTIVE' }]);
    const outsider: Principal = { userId: outsiderId as ID, workspaceId: otherWorkspaceId as ID, roles: ['OWNER'] };
    await expectError('NOT_FOUND', () => store.getOperation(outsider, created.operationId as ID), 'a principal in another workspace cannot see this operation');

    // --- 6. Quote and acceptance reuse the existing commercial flow, unchanged ----------------
    const commerce = new CommerceService(store);
    const quote = await commerce.quote(owner, created.operationId, offerEntry.offerId as string, created.revisionId) as { id: string; amountMinor: number; currency: string };
    check(quote.amountMinor === 0 && quote.currency === 'EUR', 'the quote carries the configured offer price, not a fabricated one');
    const order = await commerce.accept(owner, quote.id as ID, 'qa-a13-acceptance-0001');
    check(order.state === 'AUTHORIZED', 'explicit acceptance of a free offer authorizes execution');

    // --- 7. validateServiceConfiguration agrees the applied configuration is healthy -----------
    const healthy = await validateServiceConfiguration(store, {
      capabilityId: template.service.capabilityId, offerId: offerEntry.offerId as string,
      workspaceId, expectedProvider: 'world-bank', maximumIterations: 4,
    });
    check(healthy.valid, 'the applied configuration validates: ' + healthy.findings.map(finding => finding.code).join(', '));
    const nullBasis = await validateServiceConfiguration(store, {
      capabilityId: template.service.capabilityId, offerId: offerEntry.offerId as string,
      workspaceId, expectedProvider: 'world-bank', maximumIterations: null,
    });
    check(nullBasis.valid, 'a missing iteration basis skips iteration-dependent checks without inventing them');

    console.log('  PART 2 PASSED: cumulative ' + assertions + ' assertions');
    return 'PASSED';
  } finally {
    await connection?.close().catch(() => undefined);
    await qa.drop().catch(error => console.error('QA database teardown warning:', error instanceof Error ? error.message : error));
  }
}

partOne();
try {
  const integration = await partTwo();
  if (integration === 'BLOCKED') {
    console.log('A13 SERVICE CATALOGUE QA PARTIAL — PART 1 PASSED (' + assertions + ' assertions), PART 2 BLOCKED.');
    console.log('This run is NOT integration evidence: the database-backed catalogue and order flow were not exercised.');
    process.exit(BLOCKED);
  }
  console.log('A13 SERVICE CATALOGUE QA PASSED: ' + assertions + ' assertions (PART 1 contracts + PART 2 catalogue and order flow).');
  process.exit(PASS);
} catch (error: unknown) {
  if (error instanceof BlockedSignal) {
    console.log('A13 SERVICE CATALOGUE QA BLOCKED: ' + error.reason);
    console.log('This run is NOT integration evidence: a required prerequisite or the database was unavailable.');
    process.exit(BLOCKED);
  }
  console.error('A13 SERVICE CATALOGUE QA FAILED:', error instanceof Error ? error.message : error);
  process.exit(FAILED);
}
