/**
 * TASK 02 QA verification (isolated database only).
 *
 * Requires QEYNOX_QA_DATABASE_URL pointing at a LOCAL PostgreSQL server (for example the
 * connection URL of a disposable container). The script creates a brand-new random database,
 * applies and re-validates migrations there, exercises the operator configuration lifecycle and
 * integrity constraints, and drops the database again. It refuses remote hosts.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { getTableColumns, isTable } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  QeyNoxStore, connectDatabase, defaultMigrationsDirectory, identityMemberships, identityUsers,
  identityWorkspaces, loadMigrations, runMigrations,
} from '@qeynox/persistence';
import * as persistence from '@qeynox/persistence';
import type { ApplyConfigurationInput, ConfigurationEntry } from '@qeynox/contracts';
import { BudgetService, CommerceService, ConfigurationService, OperationExecutionService, PlanningService } from '@qeynox/application';
import { DomainError, newId, type ID, type Principal } from '@qeynox/domain';

const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
const qaDatabasePattern = /^qeynox_qa_[a-z0-9_]{6,40}$/;
let assertions = 0;
let databaseName: string | undefined;

function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
async function expectDomainError(code: string, run: () => Promise<unknown> | unknown, label: string): Promise<void> {
  assertions++;
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === code) return;
    throw new Error('EXPECTED ' + code + ' for ' + label + ', got ' + (error instanceof DomainError ? error.code : String(error)));
  }
  throw new Error('EXPECTED ' + code + ' for ' + label + ', but no error was raised');
}
async function expectDatabaseError(code: string, pool: Pool, sqlText: string, label: string): Promise<void> {
  assertions++;
  try {
    await pool.query(sqlText);
  } catch (error: unknown) {
    if ((error as { code?: string }).code === code) return;
    throw new Error('EXPECTED PG ' + code + ' for ' + label + ', got ' + String((error as { code?: string }).code ?? error));
  }
  throw new Error('EXPECTED PG ' + code + ' for ' + label + ', but the statement succeeded');
}

const qaValidFrom = '2026-01-01T00:00:00.000Z';
const capabilityIdV1 = 'capability-slot-1-v1';
const capabilityIdV2 = 'capability-slot-1-v2';

function toolEntry(status: 'ACTIVE' | 'DISABLED' = 'ACTIVE'): ConfigurationEntry {
  return {
    domain: 'TOOL', connectorId: 'world-bank', version: '1', status,
    manifest: {
      description: 'QA verification declaration for the documented World Bank indicator adapter',
      provider: 'World Bank', regions: ['GLOBAL'], operations: ['INDICATOR_RESEARCH'],
      mode: 'READ_ONLY',
      licenseNotes: 'QA fixture only; reuse and attribution terms must be verified by the operator',
      termsUrl: 'https://datahelpdesk.worldbank.org/knowledgebase/articles/889392',
      freshness: { ttlSeconds: 86400, publishedAtSource: 'UNKNOWN' },
      rateLimit: { maxPerMinute: 30 },
      tools: [{ name: 'indicator', version: '1' }],
    },
  };
}
function capabilityEntry(version: number, status: 'ACTIVE' | 'DISABLED', name = 'QA Evidence Capability'): ConfigurationEntry {
  return {
    domain: 'BUSINESS_CAPABILITY', slot: 1, version, status,
    name, purpose: 'QA-only capability definition used to verify configuration lifecycle; not a production business definition.',
    scope: ['QA verification scope'], allowedTools: ['world-bank:indicator@1'], privacyScopes: ['context:read'],
    inputSchemaVersion: 1, outputSchemaVersion: 1, maximumSteps: 10, maximumToolCalls: 2,
  };
}
function profileEntry(domain: 'AGENT_PROFILE' | 'SOUL_PROFILE' | 'PILOT_PROFILE', version = 1): ConfigurationEntry {
  const base = {
    version, status: 'ACTIVE' as const, title: 'QA ' + domain + ' profile v' + version,
    systemInstructions: 'QA-only instructions: never claim unverified results and never invoke tools directly.',
    skillRefs: [], allowedTools: [] as string[], permittedContextKeys: ['context:read'] as string[],
    maxOutputTokens: 512, maxIterations: 2,
  };
  if (domain === 'AGENT_PROFILE') return { domain, slot: 1, ...base, allowedTools: ['world-bank:indicator@1'] } as ConfigurationEntry;
  return { domain, ...base } as ConfigurationEntry;
}
function verificationEntry(capabilityId: string, version = 1, status: 'ACTIVE' | 'DISABLED' = 'ACTIVE'): ConfigurationEntry {
  return {
    domain: 'VERIFICATION_POLICY', capabilityId, version, status,
    minimumSources: 1, maxAgeDays: 30, approvedProviders: ['world-bank'],
    humanReviewRequired: false, validFrom: qaValidFrom,
  };
}
function offerEntry(version = 1, status: 'ACTIVE' | 'DISABLED' = 'ACTIVE', capabilityIds: readonly string[] = [capabilityIdV1]): ConfigurationEntry {
  return {
    domain: 'RAAS_OFFER', offerId: 'qa-offer-1', version, status, label: 'QA Test Offer',
    capabilityIds: [...capabilityIds], deliverableSchemaVersion: 1, scope: ['QA verification scope'], exclusions: [],
    regions: ['GLOBAL'], locales: ['en'], termsVersion: 'qa-terms-1', currency: 'USD', amountMinor: 0,
    taxPolicy: 'CONFIGURED', isExplicitlyFree: true,
  };
}
function budgetEntry(version = 1, status: 'ACTIVE' | 'DISABLED' = 'ACTIVE'): ConfigurationEntry {
  return {
    domain: 'BUDGET_POLICY', policyId: 'default', version, status, currency: 'USD',
    maxMoneyMinor: 1000, maxAgentCalls: 3, maxToolCalls: 3, maxDurationSeconds: 600, maxConcurrent: 1,
    unitMaxMinor: { hermes: 10, 'world-bank:indicator@1': 0 },
  };
}
function fullBundle(): ConfigurationEntry[] {
  return [
    toolEntry(), capabilityEntry(1, 'ACTIVE'), profileEntry('AGENT_PROFILE'), profileEntry('SOUL_PROFILE'),
    profileEntry('PILOT_PROFILE'), verificationEntry(capabilityIdV1), offerEntry(), budgetEntry(),
  ];
}
function applyInput(idempotencyKey: string, entries: ConfigurationEntry[], dryRun = false): ApplyConfigurationInput {
  return { idempotencyKey, entries, dryRun } as ApplyConfigurationInput;
}

interface SchemaColumn { type: string; nullable: boolean }
const drizzleTypeMap: Readonly<Record<string, string>> = { string: 'text', number: 'integer', boolean: 'boolean', json: 'jsonb', date: 'timestamp with time zone' };

async function verifySchemaParity(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
    "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, column_name",
  );
  const actual = new Map<string, Map<string, SchemaColumn>>();
  for (const row of rows) {
    if (!actual.has(row.table_name)) actual.set(row.table_name, new Map());
    actual.get(row.table_name)!.set(row.column_name, { type: row.data_type, nullable: row.is_nullable === 'YES' });
  }
  const expected = new Map<string, Map<string, SchemaColumn>>();
  for (const value of Object.values(persistence)) {
    if (!isTable(value)) continue;
    const table = value as unknown as PgTable;
    const config = getTableConfig(table);
    const columns = new Map<string, SchemaColumn>();
    for (const column of Object.values(getTableColumns(table))) {
      const mapped = drizzleTypeMap[column.dataType];
      assert(mapped !== undefined, 'drizzle type mapping missing for ' + config.name + '.' + column.name + ' (' + column.dataType + ')');
      columns.set(column.name, { type: mapped, nullable: !column.notNull });
    }
    expected.set(config.name, columns);
  }
  assert(expected.size > 50, 'drizzle schema exposes the full table inventory');
  for (const [table, columns] of expected) {
    const database = actual.get(table);
    assert(database !== undefined, 'migration created table ' + table);
    for (const [column, expectation] of columns) {
      const found = database.get(column);
      assert(found !== undefined, 'migration created column ' + table + '.' + column);
      assert(found.type === expectation.type, 'type parity ' + table + '.' + column + ': db=' + found.type + ' drizzle=' + expectation.type);
      assert(found.nullable === expectation.nullable, 'nullability parity ' + table + '.' + column);
    }
    for (const column of database.keys()) assert(columns.has(column), 'no undeclared extra column ' + table + '.' + column);
  }
  for (const table of actual.keys()) {
    if (table === 'schema_migrations') continue;
    assert(expected.has(table), 'no undeclared extra table ' + table);
  }
  const indexes = await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname='public'");
  const indexNames = new Set(indexes.rows.map(row => row.indexname));
  for (const name of [
    'capability_active_slot_unique', 'agent_profile_active_role_unique', 'verification_policy_active_capability_unique',
    'raas_offer_active_id_unique', 'tool_configuration_connector_version_unique', 'tool_configuration_active_connector_unique',
    'budget_policy_workspace_key_version_unique', 'budget_policy_active_workspace_unique', 'configuration_record_workspace_key_unique',
  ]) assert(indexNames.has(name), 'integrity index exists: ' + name);
}

async function verifyMigrationImmutability(targetUrl: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'qeynox-migrations-'));
  const transactionDirectory = await mkdtemp(join(tmpdir(), 'qeynox-migrations-tx-'));
  try {
    for (const name of await readdir(defaultMigrationsDirectory)) {
      await writeFile(join(directory, name), await readFile(join(defaultMigrationsDirectory, name), 'utf8'));
    }
    const first = '0001_foundations.sql';
    await writeFile(join(directory, first), (await readFile(join(directory, first), 'utf8')) + '\n-- tampered during QA verification\n');
    await expectDomainError('CONFLICT', () => runMigrations(targetUrl, { directory }), 'changed applied migration checksum');
    await writeFile(join(transactionDirectory, '0001_test.sql'), 'BEGIN;\nCREATE TABLE IF NOT EXISTS qa_forbidden(id text);\nCOMMIT;\n');
    await expectDomainError('INVALID_INPUT', () => loadMigrations(transactionDirectory), 'migration file with transaction control');
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(transactionDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const adminUrlValue = process.env.QEYNOX_QA_DATABASE_URL;
  if (!adminUrlValue) throw new DomainError('NOT_CONFIGURED', 'QEYNOX_QA_DATABASE_URL is required for the isolated QA run');
  const adminUrl = new URL(adminUrlValue);
  if (!localHosts.has(adminUrl.hostname)) throw new DomainError('DENIED', 'QA verification refuses non-local database hosts: ' + adminUrl.hostname);
  databaseName = 'qeynox_qa_' + randomUUID().replace(/-/g, '').slice(0, 16);
  assert(qaDatabasePattern.test(databaseName), 'generated QA database name is isolated and safe');
  const admin = new Pool({ connectionString: adminUrlValue, max: 1 });
  const targetUrl = new URL(adminUrlValue);
  targetUrl.pathname = '/' + databaseName;
  const targetConnectionString = targetUrl.toString();
  let connection: Awaited<ReturnType<typeof connectDatabase>> | undefined;
  let pool: Pool | undefined;
  try {
    await admin.query('CREATE DATABASE "' + databaseName + '"');
    console.log('QA database created:', databaseName);

    const migrations = await loadMigrations();
    const firstRun = await runMigrations(targetConnectionString);
    assert(firstRun.applied.length === migrations.length, 'fresh database applied every migration (' + firstRun.applied.length + '/' + migrations.length + ')');
    assert(firstRun.skipped.length === 0, 'fresh database skipped no migration');
    const secondRun = await runMigrations(targetConnectionString);
    assert(secondRun.applied.length === 0, 'migration rerun applies nothing');
    assert(secondRun.skipped.length === migrations.length, 'migration rerun records every migration as already applied');

    pool = new Pool({ connectionString: targetConnectionString, max: 4 });
    await verifySchemaParity(pool);
    await verifyMigrationImmutability(targetConnectionString);

    connection = connectDatabase(targetConnectionString);
    const db = connection.db;
    const store = new QeyNoxStore(db);
    const configuration = new ConfigurationService(store);
    const planning = new PlanningService(store);
    const budgets = new BudgetService(store);
    const commerce = new CommerceService(store);
    const execution = new OperationExecutionService(store);

    const ownerUserId = randomUUID(), memberUserId = randomUUID(), outsiderUserId = randomUUID(), workspaceId = randomUUID();
    await db.insert(identityUsers).values([
      { id: ownerUserId, email: 'qa-owner-' + ownerUserId + '@example.invalid' },
      { id: memberUserId, email: 'qa-member-' + memberUserId + '@example.invalid' },
    ]);
    await db.insert(identityWorkspaces).values({ id: workspaceId, name: 'QA Workspace', createdBy: ownerUserId });
    await db.insert(identityMemberships).values([
      { id: randomUUID(), userId: ownerUserId, workspaceId, role: 'OWNER', status: 'ACTIVE' },
      { id: randomUUID(), userId: memberUserId, workspaceId, role: 'MEMBER', status: 'ACTIVE' },
    ]);
    const owner: Principal = { userId: ownerUserId as ID, workspaceId: workspaceId as ID, roles: ['OWNER'] };
    const member: Principal = { userId: memberUserId as ID, workspaceId: workspaceId as ID, roles: ['MEMBER'] };

    // Unconfigured runtime must fail closed.
    const operation = await store.createOperation(owner, 'QA configuration operation', 'QA objective for configuration lifecycle verification', []);
    await expectDomainError('NOT_CONFIGURED', () => planning.create(owner, operation.id, operation.version, [{
      title: 'QA step', description: 'QA step description for configuration verification', capabilityId: capabilityIdV1 as ID,
      dependsOnIndices: [], intent: 'RESEARCH',
    }]), 'planning with unconfigured capability');
    await expectDomainError('NOT_CONFIGURED', () => budgets.ensureBudget(owner, operation.id), 'operation budget without active policy');

    // Operator permissions.
    delete process.env.QEYNOX_OPERATOR_USER_IDS;
    await expectDomainError('NOT_CONFIGURED', () => configuration.state(owner), 'operator configuration with unset allowlist');
    process.env.QEYNOX_OPERATOR_USER_IDS = outsiderUserId;
    await expectDomainError('DENIED', () => configuration.state(owner), 'non-allowlisted account');
    process.env.QEYNOX_OPERATOR_USER_IDS = ownerUserId + ',' + memberUserId;
    await expectDomainError('DENIED', () => configuration.state(member), 'allowlisted non-operator workspace member');
    process.env.QEYNOX_OPERATOR_USER_IDS = ownerUserId;
    const initialState = await configuration.state(owner);
    assert(initialState.capabilities.filter(slot => slot.status === 'ACTIVE').length === 0, 'all eight capability slots start unconfigured');

    // Full configuration bundle.
    const applied = await configuration.apply(owner, applyInput('qa-config-bundle-1', fullBundle()));
    assert(!applied.alreadyApplied && !applied.dryRun, 'bundle applied for the first time');
    assert(applied.changes.length === 8 && applied.changes.every(change => change.outcome === 'CREATE'), 'all eight configuration domains created');
    const configuredState = await configuration.state(owner);
    assert(configuredState.capabilities[0]?.status === 'ACTIVE' && configuredState.capabilities[0].capabilityId === capabilityIdV1, 'capability slot 1 active');
    assert(configuredState.capabilities.slice(1).every(slot => slot.status === 'UNCONFIGURED'), 'unconfigured slots stay unconfigured');
    assert(configuredState.profiles.filter(profile => profile.status === 'ACTIVE').length === 3, 'soul, pilot and business slot 1 profiles configured');
    assert(configuredState.profiles.filter(profile => profile.status === 'UNCONFIGURED').length === 7, 'unconfigured business profiles stay unconfigured');
    assert(configuredState.tools.length === 1 && configuredState.verificationPolicies.length === 1, 'tool and verification policy configured');
    assert(configuredState.offers.length === 1 && configuredState.budgetPolicies.length === 1, 'offer and budget policy configured');

    // Idempotency and immutability.
    const replayed = await configuration.apply(owner, applyInput('qa-config-bundle-2', fullBundle()));
    assert(replayed.changes.length === 8 && replayed.changes.every(change => change.outcome === 'UNCHANGED'), 're-applying identical configuration is a no-op');
    const sameKey = await configuration.apply(owner, applyInput('qa-config-bundle-1', fullBundle()));
    assert(sameKey.alreadyApplied, 'same idempotency key returns the recorded result');
    const differentDigest = fullBundle().map(entry => entry.domain === 'BUSINESS_CAPABILITY' ? { ...entry, name: 'QA changed name' } : entry);
    await expectDomainError('CONFLICT', () => configuration.apply(owner, applyInput('qa-config-bundle-1', differentDigest)), 'idempotency key reused for different content');
    const immutableVersion = fullBundle().map(entry => entry.domain === 'BUSINESS_CAPABILITY' ? { ...entry, name: 'QA immutable changed name' } : entry);
    await expectDomainError('CONFLICT', () => configuration.apply(owner, applyInput('qa-config-immutable', immutableVersion)), 'immutable version content');
    const atomicBefore = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM tool_configurations');
    await expectDomainError('NOT_CONFIGURED', () => configuration.apply(owner, applyInput('qa-config-invalid-reference', [
      { ...toolEntry(), connectorId: 'qa-atomic-tool' },
      { ...verificationEntry('capability-slot-7-v1'), version: 1 },
    ] as ConfigurationEntry[])), 'verification policy for inactive capability');
    const atomicAfter = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM tool_configurations');
    assert(atomicBefore.rows[0]?.count === atomicAfter.rows[0]?.count, 'failed bundle rolls back every write');
    const dryRun = await configuration.apply(owner, applyInput('qa-config-dry-run', [capabilityEntry(2, 'ACTIVE')], true));
    assert(dryRun.dryRun && dryRun.changes[0]?.outcome === 'CREATE', 'dry run reports planned change');
    assert((await configuration.state(owner)).capabilities[0]?.version === 1, 'dry run writes nothing');

    // Version lifecycle: activate v2, deactivate it, reactivate it.
    await configuration.apply(owner, applyInput('qa-config-capability-v2', [capabilityEntry(2, 'ACTIVE')]));
    const v2State = await configuration.state(owner);
    assert(v2State.capabilities[0]?.version === 2 && v2State.capabilities[0].capabilityId === capabilityIdV2, 'capability v2 is the only active version');
    const v1Row = await pool.query<{ status: string; payload: { status?: string } }>('SELECT status, payload FROM capabilities WHERE id=$1', [capabilityIdV1]);
    assert(v1Row.rows[0]?.status === 'DISABLED' && v1Row.rows[0]?.payload.status === 'DISABLED', 'superseded version is disabled consistently');
    await configuration.apply(owner, applyInput('qa-config-capability-disable', [capabilityEntry(2, 'DISABLED')]));
    assert((await configuration.state(owner)).capabilities[0]?.status === 'UNCONFIGURED', 'disabling the active version leaves the slot unconfigured');
    await expectDomainError('NOT_CONFIGURED', () => planning.create(owner, operation.id, operation.version, [{
      title: 'QA step', description: 'QA step description for configuration verification', capabilityId: capabilityIdV2 as ID,
      dependsOnIndices: [], intent: 'RESEARCH',
    }]), 'planning after capability deactivation');
    await configuration.apply(owner, applyInput('qa-config-capability-reactivate', [capabilityEntry(2, 'ACTIVE')]));
    assert((await configuration.state(owner)).capabilities[0]?.status === 'ACTIVE', 'capability reactivation restores the slot');
    await configuration.apply(owner, applyInput('qa-config-offer-v2', [offerEntry(2, 'ACTIVE', [capabilityIdV2])]));
    const offerState = await configuration.state(owner);
    assert(offerState.offers.filter(offer => offer.status === 'ACTIVE').length === 1 && offerState.offers.find(offer => offer.status === 'ACTIVE')?.version === 2, 'offer v2 supersedes v1 for the active capability');

    // Budget materialization and execution gate.
    const budgetPolicy = await budgets.ensureBudget(owner, operation.id);
    assert(budgetPolicy.version === 1 && Object.keys(budgetPolicy.unitMaxMinor).includes('hermes'), 'active budget policy materialized');
    const budgetAgain = await budgets.ensureBudget(owner, operation.id);
    assert(budgetAgain.version === budgetPolicy.version, 'budget materialization is idempotent');
    const budgetRows = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM operation_budgets WHERE operation_id=$1', [operation.id]);
    assert(budgetRows.rows[0]?.count === '1', 'exactly one operation budget row exists');

    const plan = await planning.create(owner, operation.id, operation.version, [{
      title: 'QA evidence step', description: 'QA step description for configuration verification',
      capabilityId: capabilityIdV2 as ID, dependsOnIndices: [], intent: 'RESEARCH',
    }]);
    const readyOperation = await store.getOperation(owner, operation.id);
    const quote = await commerce.quote(owner, operation.id, 'qa-offer-1', plan.revision.id) as { id: string; amountMinor: number };
    assert(quote.amountMinor === 0, 'explicitly free QA offer quotes at zero');
    const accepted = await commerce.accept(owner, quote.id as ID, 'qa-acceptance-0001');
    assert(accepted.state === 'AUTHORIZED', 'explicitly free offer authorizes fulfilment');
    const started = await execution.start(owner, operation.id, readyOperation.version, 'qa-start-0001') as { attemptId: ID };
    assert(typeof started.attemptId === 'string', 'execution start creates a step attempt');
    const outboxRows = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM outbox WHERE operation_id=$1', [operation.id]);
    assert(outboxRows.rows[0]?.count === '1', 'execution start records exactly one outbox intent');
    const reserve = await budgets.reserve(owner, operation.id, started.attemptId, 'ENGINE', 'hermes', 'qa-reservation-1');
    assert(reserve.maximumCostMinor === 10, 'configured engine cost ceiling is reserved');
    await budgets.settle(owner, reserve.reservationId as ID, { costMinor: 0, origin: 'ESTIMATED' });
    const settled = await pool.query<{ state: string }>('SELECT state FROM usage_reservations WHERE id=$1', [reserve.reservationId]);
    assert(settled.rows[0]?.state === 'SETTLED', 'reservation settles against the configured budget');

    // Schema integrity constraints.
    await expectDatabaseError('23514', pool, "INSERT INTO capabilities(id,slot,version,status,payload) VALUES ('qa-constraint-slot',9,1,'ACTIVE','{}')", 'capability slot range check');
    await expectDatabaseError('23514', pool, "INSERT INTO capabilities(id,slot,version,status,payload) VALUES ('qa-constraint-slot',0,1,'ACTIVE','{}')", 'capability slot lower bound');
    await pool.query("INSERT INTO capabilities(id,slot,version,status,payload) VALUES ('qa-constraint-slot',8,1,'ACTIVE','{\"status\":\"ACTIVE\"}')");
    await expectDatabaseError('23505', pool, "INSERT INTO capabilities(id,slot,version,status,payload) VALUES ('qa-constraint-slot-dup',8,1,'DISABLED','{}')", 'capability slot/version uniqueness');
    await expectDatabaseError('23505', pool, "INSERT INTO capabilities(id,slot,version,status,payload) VALUES ('qa-constraint-slot-dup2',8,2,'ACTIVE','{}')", 'single active capability per slot');
    await expectDatabaseError('23502', pool, "INSERT INTO capabilities(id,slot,version,status,payload) VALUES ('qa-constraint-null',7,1,'ACTIVE',NULL)", 'capability payload not null');
    await pool.query("INSERT INTO agent_profiles(id,role_key,version,active,payload) VALUES ('qa-constraint-profile','qa-constraint',1,true,'{}')");
    await expectDatabaseError('23505', pool, "INSERT INTO agent_profiles(id,role_key,version,active,payload) VALUES ('qa-constraint-profile-2','qa-constraint',2,true,'{}')", 'single active profile per role');
    await expectDatabaseError('23503', pool, "INSERT INTO claim_evidence_links(id,claim_id,source_id,relationship,added_at) VALUES ('qa-constraint-link','qa-missing-claim','qa-source','SUPPORTS',now()::text)", 'claim evidence foreign key');
    await pool.query("INSERT INTO raas_offers(id,version,status,currency,amount_minor,configuration) VALUES ('qa-constraint-offer',1,'ACTIVE','USD',0,'{}')");
    await expectDatabaseError('23505', pool, "INSERT INTO raas_offers(id,version,status,currency,amount_minor,configuration) VALUES ('qa-constraint-offer',2,'ACTIVE','USD',0,'{}')", 'single active offer version');
    await pool.query("INSERT INTO verification_policies(id,capability_id,version,minimum_sources,max_age_days,approved_providers,human_review_required,valid_from,status) VALUES ('qa-constraint-policy','qa-constraint-cap',1,1,1,'[]','false',now()::text,'ACTIVE')");
    await expectDatabaseError('23505', pool, "INSERT INTO verification_policies(id,capability_id,version,minimum_sources,max_age_days,approved_providers,human_review_required,valid_from,status) VALUES ('qa-constraint-policy-2','qa-constraint-cap',2,1,1,'[]','false',now()::text,'ACTIVE')", 'single active verification policy per capability');
    await expectDatabaseError('23503', pool, "INSERT INTO budget_policies(id,workspace_id,version,status,payload,digest,configured_by) VALUES ('qa-constraint-budget','qa-missing-workspace',1,'ACTIVE','{}','x','qa')", 'budget policy workspace foreign key');
    await pool.query("DELETE FROM verification_policies WHERE id LIKE 'qa-constraint-policy%'");
    await pool.query("DELETE FROM raas_offers WHERE id='qa-constraint-offer'");
    await pool.query("DELETE FROM agent_profiles WHERE id LIKE 'qa-constraint-profile%'");
    await pool.query("DELETE FROM capabilities WHERE id LIKE 'qa-constraint-slot%' OR id='qa-constraint-null'");

    const audit = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM configuration_records WHERE workspace_id=$1', [workspaceId]);
    assert(Number(audit.rows[0]?.count) === 6, 'every applied bundle is recorded for audit');
    console.log('QA verification PASSED:', assertions, 'assertions');
  } finally {
    await connection?.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    try {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query('DROP DATABASE IF EXISTS "' + databaseName + '"');
      console.log('QA database dropped:', databaseName);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }
}

main().catch((error: unknown) => {
  console.error('QA verification FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
