/** Local regression checks only: no database, S3, provider call or runtime attestation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SerialPoller } from '../src/serial-poller';
import { assertConsent, contextSubset, DomainError, requireId, type Consent, type UserContext } from '@qeynox/domain';
import {
  EgressPolicy, isPrivateOrReservedAddress, resolvePinnedProviderAddress, ToolBroker, ToolRegistry,
  WorldBankConnector, worldBankManifest, type ConnectorCall, type PermissionContext,
  type ToolConnector, type ToolDefinition, type ToolLedgerPort,
} from '@qeynox/tools';

const userId = requireId('audit-user-0001');
const workspaceId = requireId('audit-workspace-0001');
const capabilityId = requireId('audit-capability-0001');
const now = '2026-11-22T12:00:00.000Z';
const consent: Consent = {
  id: requireId('audit-consent-0001'), userId, workspaceId, purpose: 'Regression fixture',
  scopes: ['context:read', 'context:write'], grantedAt: '2026-11-21T00:00:00.000Z', version: 1,
};
const denied = (error: unknown): boolean => error instanceof DomainError && error.code === 'DENIED';

test('egress rejects equivalent IPv6 spellings and non-public transition/reserved ranges', async () => {
  const reserved = [
    '0:0:0:0:0:0:0:0', '0:0:0:0:0:0:0:1', '::01',
    '0:0:0:0:0:ffff:7f00:1', '::ffff:0a00:1', '0:0:0:0:0:ffff:169.254.169.254',
    '0064:ff9b::a00:1', '64:ff9b:1::1', '100::1', '100:0:0:1::1',
    '2001::1', '2001:10::1', '2001:20::1', '2001:2::1', '2002:7f00:1::1',
    '2001:0db8::1', '3fff::1', '3fff:fff::1', 'fec0::1', '192.88.99.1',
  ];
  for (const address of reserved) {
    assert.equal(isPrivateOrReservedAddress(address), true, address);
    await assert.rejects(resolvePinnedProviderAddress('provider.example', async () => [{ address, family: address.includes(':') ? 6 : 4 }]), denied, address);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e']) {
    assert.equal(isPrivateOrReservedAddress(address), false, address);
    assert.equal((await resolvePinnedProviderAddress('provider.example', async () => [{ address, family: address.includes(':') ? 6 : 4 }])).address, address);
  }
});

test('consent expiry is temporal, timezone-aware and fail-closed for malformed timestamps', () => {
  const fact: UserContext = {
    id: requireId('audit-fact-0001'), workspaceId, ownerUserId: userId, consentId: consent.id,
    key: 'business', value: 'private fixture', origin: 'USER', createdAt: now, updatedAt: now,
  };
  for (const expiresAt of ['invalid', '', '9999-not-a-date', '2026-11-22T13:00:00+02:00', now, '2026-11-22', '2026-11-22T14:00:00', '2027-02-30T00:00:00Z', '2026-11-22T24:00:00Z']) {
    const expired = { ...consent, expiresAt };
    assert.throws(() => assertConsent(expired, 'context:read', userId, workspaceId, now), denied, expiresAt);
    assert.deepEqual(contextSubset([fact], [expired], ['context:read'], now), [], expiresAt);
  }
  for (const expiresAt of [undefined, '2026-11-22T11:30:00-02:00', '2026-11-22T12:00:00.001Z']) {
    const active = { ...consent, expiresAt };
    assert.doesNotThrow(() => assertConsent(active, 'context:read', userId, workspaceId, now));
    assert.equal(contextSubset([fact], [active], ['context:read'], now).length, 1);
  }
  assert.throws(() => assertConsent(consent, 'context:read', userId, workspaceId, 'invalid'), denied);
  assert.throws(() => assertConsent({ ...consent, revokedAt: now }, 'context:read', userId, workspaceId, now), denied);
  assert.throws(() => assertConsent(consent, 'context:read', userId, 'other-workspace', now), denied);
  assert.throws(() => assertConsent(consent, 'context:read', 'other-user', workspaceId, now), denied);
  assert.throws(() => assertConsent(consent, 'missing-scope', userId, workspaceId, now), denied);
});

const provider = new WorldBankConnector([capabilityId], new EgressPolicy({ attested: false, allowedHosts: [] }));
const baseDefinition = provider.definitions()[0]!;
function connector(definitions: readonly ToolDefinition[]): ToolConnector {
  return { id: provider.id, version: provider.version, definitions: () => definitions, invoke: () => { throw new Error('Unexpected provider call'); } };
}

test('tool registry rejects non-finite limits and registration is atomic', () => {
  for (const timeoutMs of [NaN, Infinity, 99, 2 ** 31, 100.5]) {
    assert.throws(() => new ToolRegistry().register(connector([{ ...baseDefinition, timeoutMs }])), DomainError, String(timeoutMs));
  }
  for (const maxCostUnits of [NaN, Infinity, -1, 0.5]) {
    assert.throws(() => new ToolRegistry().register(connector([{ ...baseDefinition, maxCostUnits }])), DomainError, String(maxCostUnits));
  }
  const duplicateRegistry = new ToolRegistry();
  assert.throws(() => duplicateRegistry.register(connector([baseDefinition, baseDefinition])), DomainError);
  assert.deepEqual(duplicateRegistry.available(), []);
  const registry = new ToolRegistry();
  assert.throws(() => registry.register(connector([baseDefinition, { ...baseDefinition, name: 'invalid', timeoutMs: 0 }])), DomainError);
  assert.deepEqual(registry.available(), [], 'invalid bundle must leave no ghost definitions');
  registry.register(provider);
  assert.equal(registry.available().length, 1, 'corrected registration is possible after rejection');
  for (const maxPerMinute of [NaN, Infinity, 0.5]) {
    assert.throws(() => new ToolRegistry().registerBundle({ connector: provider, manifest: { ...worldBankManifest, rateLimit: { maxPerMinute } } }), DomainError);
  }
  for (const ttlSeconds of [NaN, Infinity, -1, 0.5]) {
    assert.throws(() => new ToolRegistry().registerBundle({ connector: provider, manifest: { ...worldBankManifest, freshness: { ttlSeconds, publishedAtSource: 'UNKNOWN' } } }), DomainError);
  }
});

test('broker rejects malformed budgets before ledger reservation or provider execution', async () => {
  let reservations = 0;
  const ledger: ToolLedgerPort = {
    reserve: async () => { reservations++; throw new Error('Reached ledger'); },
    complete: async () => { throw new Error('Unexpected completion'); },
    fail: async () => { throw new Error('Unexpected failure'); },
  };
  const registry = new ToolRegistry();
  registry.registerBundle({ connector: provider, manifest: { ...worldBankManifest, rateLimit: { maxPerMinute: 100 } } });
  const broker = new ToolBroker(registry, ledger);
  const call: ConnectorCall = {
    operationId: requireId('audit-operation-0001'), stepAttemptId: requireId('audit-attempt-0001'),
    planRevisionId: requireId('audit-revision-0001'), capabilityId, connectorId: provider.id,
    toolName: 'indicator', version: '1', input: { country: 'USA', indicator: 'NY.GDP.MKTP.CD' },
    idempotencyKey: 'audit-call-0001', intentId: requireId('audit-intent-0001'),
  };
  const permission: PermissionContext = {
    principal: { userId, workspaceId, roles: ['MEMBER'] }, operationId: call.operationId,
    stepAttemptId: call.stepAttemptId, planRevisionId: call.planRevisionId, capabilityId,
    profileId: requireId('audit-profile-0001'), profileVersion: 1,
    allowedConnectorTools: ['world-bank:indicator@1'], consentScopes: [], approvedRequests: [],
    remainingCostUnits: 0, remainingToolCalls: 1,
  };
  for (const field of ['remainingCostUnits', 'remainingToolCalls'] as const) {
    for (const value of [NaN, Infinity, -1, 0.5]) {
      await assert.rejects(broker.invoke(call, { ...permission, [field]: value }), denied, field + ':' + value);
    }
  }
  assert.equal(reservations, 0);
  await assert.rejects(broker.invoke(call, permission), /Reached ledger/, 'valid zero-cost call reaches the ledger');
  assert.equal(reservations, 1);
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => { throw new Error('Deferred not initialized'); };
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('worker poller serializes slow drains and stop waits for the active drain', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const first = deferred(), second = deferred();
  let calls = 0;
  const poller = new SerialPoller(async () => {
    calls++;
    await (calls === 1 ? first.promise : second.promise);
  }, 5, error => { throw error; });
  const starting = poller.start();
  assert.equal(poller.start(), starting, 'duplicate start shares the active drain');
  context.mock.timers.tick(100);
  assert.equal(calls, 1, 'no drain may overlap the slow first call');
  first.resolve();
  await starting;
  context.mock.timers.tick(5);
  assert.equal(calls, 2);
  let stopped = false;
  const stopping = poller.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, 'resources must remain open until the drain finishes');
  context.mock.timers.tick(100);
  assert.equal(calls, 2);
  second.resolve();
  await stopping;
  context.mock.timers.tick(100);
  await poller.start();
  await poller.stop();
  assert.equal(calls, 2, 'neither a timer nor restart can schedule work after stop');
});

test('worker poller handles rejection and continues without unhandled promises', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const errors: unknown[] = [];
  let calls = 0;
  const failure = new Error('drain failed');
  const poller = new SerialPoller(async () => {
    calls++;
    if (calls === 1) throw failure;
  }, 5, error => { errors.push(error); });
  await poller.start();
  assert.equal(errors.length, 1);
  assert.equal(errors[0], failure);
  context.mock.timers.tick(5);
  await poller.stop();
  assert.equal(calls, 2, 'a failed drain does not permanently stop polling');
  context.mock.timers.tick(100);
  assert.equal(calls, 2);
  const stoppedBeforeStart = new SerialPoller(async () => { throw new Error('must not run'); }, 5, error => { errors.push(error); });
  await stoppedBeforeStart.stop();
  await stoppedBeforeStart.start();
  assert.equal(errors.length, 1);
  assert.equal(errors[0], failure);
  for (const interval of [NaN, Infinity, 0, -1, 0.5, 2 ** 31]) {
    assert.throws(() => new SerialPoller(async () => {}, interval, () => {}), RangeError);
  }
});
