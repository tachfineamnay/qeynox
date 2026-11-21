// Flow 2.0 targeted QA: isolated HTTP fixture + production build (no database, no agent runtime).
// Verifies the mission surface (EN/FR, availability states, dedupe, drawer focus) and the
// RUNNING / WAITING_APPROVAL / RESULT presentation variants with deterministic fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer as createPortProbe } from 'node:net';

const serve = process.argv.includes('--serve');
const token = 'q'.repeat(64);
const now = '2026-11-16T20:00:00.000Z';
let mode = 'normal';

const operation = { id: 'operation_qa', title: 'QA mission workspace', status: 'WAITING_APPROVAL', version: 3, lastActivityAt: now };
const plan = {
  operation: { ...operation, currentRevisionId: 'revision_qa', lastErrorCode: null },
  goal: { statement: 'Évaluer la demande de pompage solaire au Maroc', constraints: ['Sources publiques uniquement', 'Décision avant fin novembre'] },
  revision: { id: 'revision_qa', revision: 2, status: 'RECORDED', reason: 'Clarifier le périmètre des sources', createdBy: 'user_qa', createdAt: now },
  steps: [
    { id: 'step_1', ordinal: 1, title: 'Cadrer le marché marocain', description: 'Définir la demande, les segments et les sources publiques utilisables.', capabilityId: 'cap_market', dependsOn: [], state: 'COMPLETED', intent: 'RESEARCH', version: 1, capabilityActive: true },
    { id: 'step_2', ordinal: 2, title: 'Comparer les sources publiques', description: 'Confronter les jeux de données publics et consigner les limites.', capabilityId: 'cap_research', dependsOn: ['step_1'], state: 'RUNNING', intent: 'VERIFY', version: 1, capabilityActive: true },
    { id: 'step_3', ordinal: 3, title: 'Préparer la revue de preuves', description: 'Assembler les constats et les preuves pour la revue humaine.', capabilityId: 'cap_analysis', dependsOn: ['step_2'], state: 'PENDING', intent: 'ANALYZE', version: 1, capabilityActive: true },
  ],
  attempts: [{ attemptId: 'attempt_qa', stepId: 'step_1', sequence: 1, state: 'COMPLETED', createdAt: now, startedAt: now, finishedAt: now, errorCode: null }, { attemptId: 'attempt_qa2', stepId: 'step_2', sequence: 1, state: 'RUNNING', createdAt: now, startedAt: now, finishedAt: null, errorCode: null }],
  approvals: [{ id: 'approval_qa', purpose: 'Autoriser une collecte externe limitée', status: 'PENDING', requestedAt: now, expiresAt: '2026-11-20T20:00:00.000Z', stepAttemptId: 'attempt_qa2', stale: false }],
  capabilities: [
    { id: 'cap_market', slot: 1, name: 'Veille marché', purpose: 'Lire la demande et les segments à partir de sources publiques.', scope: ['Maroc'], maximumSteps: 6, maximumToolCalls: 12, externalActions: false, providerReady: true, missingProviders: [], profileReady: true, policyReady: true, missingPolicies: [], operationalState: 'OPERATIONAL', isExecutable: true },
    { id: 'cap_research', slot: 2, name: 'Recherche documentaire', purpose: 'Comparer des documents publics et enregistrer les preuves.', scope: ['Maroc'], maximumSteps: 5, maximumToolCalls: 10, externalActions: false, providerReady: true, missingProviders: [], profileReady: true, policyReady: true, missingPolicies: [], operationalState: 'OPERATIONAL', isExecutable: true },
    { id: 'cap_analysis', slot: 3, name: 'Analyse de preuves', purpose: 'Consolider les constats et préparer la revue humaine.', scope: ['Maroc'], maximumSteps: 4, maximumToolCalls: 8, externalActions: false, providerReady: true, missingProviders: [], profileReady: true, policyReady: true, missingPolicies: [], operationalState: 'OPERATIONAL', isExecutable: true },
  ],
};
const readiness = {
  operationId: operation.id, version: 3, status: 'WAITING_APPROVAL', revisionId: 'revision_qa', canStart: false, operationalState: 'BLOCKED',
  blockers: [{ code: 'STATUS_NOT_STARTABLE', detail: 'The recorded mission status does not allow a launch.', category: 'PLAN' }],
  plan: { present: true, revision: 2, steps: 3 },
  cost: { known: true, amountMinor: 120000, currency: 'MAD', orderState: 'AUTHORIZED' },
  budget: { configured: true, currency: 'MAD', maxMoneyMinor: 300000, spentMinor: 120000, reservedMinor: 0 },
  capabilities: { required: 3, active: 3, missing: [] },
  approvals: { pending: 1 },
  prerequisites: {
    plan: { ok: true, steps: 3, revision: 2 },
    capability: { ok: true, required: 3, active: 3, missing: [] },
    offer: { ok: true, offerId: 'offer_qa', label: 'Offre recherche Maroc', amountMinor: 120000, currency: 'MAD', isExplicitlyFree: false },
    order: { ok: true, state: 'AUTHORIZED', amountMinor: 120000, currency: 'MAD' },
    budget: { ok: true, source: 'POLICY', currency: 'MAD', ceiling: 300000, spent: 120000, reserved: 0 },
    permission: { ok: true, role: 'OWNER' },
    // A21.07 wire shape: each component carries its own customer-safe live-check summary.
    engine: { ok: true, runtime: 'hermes', missing: [], state: 'OPERATIONAL', verifiedLive: true, attested: true, verification: { status: 'VERIFIED', failure: null, checkedAt: now, expiresAt: now } },
    orchestrator: { ok: true, runtime: 'hatchet', missing: [], state: 'OPERATIONAL', verifiedLive: true, attested: true, verification: { status: 'VERIFIED', failure: null, checkedAt: now, expiresAt: now } },
    profile: { ok: true, missing: [] },
    provider: { ok: true, missing: [] },
    policy: { ok: true, missing: [] },
    executionAuthorization: { ok: true, state: 'AUTHORIZED', authorized: true },
  },
};
const summary = { operationId: operation.id, status: 'WAITING_APPROVAL', stepCount: 3, completedSteps: 1, pendingApprovals: 1, lastSequence: 3 };
const citation = { sourceId: 'source_qa', provider: 'QA source', uri: 'https://example.org/evidence', retrievedAt: now };
const document = {
  id: 'document_qa', operationId: operation.id, revisionId: 'revision_qa', version: 2, title: 'QA evidence document', objective: 'QA objective', status: 'READY_FOR_REVIEW',
  scope: ['Maroc'], findings: [{ claimId: 'claim_qa', statement: 'QA finding', status: 'UNVERIFIED', limitations: ['Needs review'], citations: [citation] }],
  nextActions: ['Review missing evidence'], limitations: ['QA limitation'], unresolved: ['claim_qa'], citations: [citation], createdAt: now,
};
const commercial = {
  operationId: operation.id, revisionId: 'revision_qa',
  offers: [{ id: 'offer_qa', version: 1, label: 'Offre recherche Maroc', amountMinor: 120000, currency: 'MAD', isExplicitlyFree: false, termsVersion: '2026-11', scope: ['Maroc'], exclusions: ['Aucune collecte privée'] }],
  quotes: [{ id: 'quote_qa', offerId: 'offer_qa', amountMinor: 120000, currency: 'MAD', expiresAt: '2026-11-30T20:00:00.000Z', createdAt: now, accepted: true, expired: false }],
  order: { id: 'order_qa', state: 'AUTHORIZED', amountMinor: 120000, currency: 'MAD', createdAt: now },
  executionAuthorized: true, payment: { required: false, state: null },
};
const claims = [
  { id: 'claim_1', statement: 'La demande publique de pompage solaire progresse au Maroc.', kind: 'MARKET', status: 'SUPPORTED', createdAt: now },
  { id: 'claim_2', statement: 'Les données publiques 2026 restent incomplètes.', kind: 'EVIDENCE', status: 'UNVERIFIED', createdAt: now },
];
const activity = {
  events: [
    { id: 'envelope_1', eventId: 'event_1', sequence: 1, kind: 'OPERATION_CREATED', occurredAt: '2026-11-16T18:00:00.000Z' },
    { id: 'envelope_2', eventId: 'event_2', sequence: 2, kind: 'EXECUTION_REQUESTED', occurredAt: '2026-11-16T18:05:00.000Z' },
    { id: 'envelope_2b', eventId: 'event_2', sequence: 2, kind: 'EXECUTION_REQUESTED', occurredAt: '2026-11-16T18:05:00.000Z' },
    { id: 'envelope_3', eventId: 'event_3', sequence: 3, kind: 'PLAN_REVISED', occurredAt: '2026-11-16T19:00:00.000Z' },
  ],
  nextCursor: 3, transport: 'POLLING',
};
const pilot = { operationId: operation.id, status: 'WAITING_APPROVAL', action: 'REVIEW_APPROVAL', reason: 'Based on recorded operation state only' };
const context = [{ id: 'fact_qa', key: 'Secteur ciblé', value: 'Énergie solaire', consentId: 'consent_qa', updatedAt: now }];
const consents = [{ id: 'consent_qa', scope: ['context:read'], grantedAt: now }];

const variant = process.env.FLOW2_VARIANT ?? 'approval';
if (variant !== 'approval') {
  operation.status = variant === 'result' ? 'COMPLETED' : 'RUNNING';
  plan.operation.status = operation.status;
  plan.approvals = [];
  summary.status = operation.status;
  summary.pendingApprovals = 0;
  readiness.status = operation.status;
  if (variant === 'result') {
    plan.steps = plan.steps.map(step => Object.assign({}, step, { state: 'COMPLETED' }));
    plan.attempts = plan.attempts.map(attempt => Object.assign({}, attempt, { state: 'COMPLETED', finishedAt: now }));
    summary.completedSteps = 3;
    document.status = 'DELIVERABLE';
    claims[0].status = 'SUPPORTED';
    claims[1].status = 'SUPPORTED';
  }
}

const backend = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  assert.equal(req.headers.authorization, 'Bearer ' + token);
  assert.equal(req.headers['x-qeynox-workspace'], 'workspace_qa');
  const url = req.url;
  let payload;
  if (url === '/v1/operations/operation_qa') payload = operation;
  if (url === '/v1/operations/operation_qa/plan') payload = plan;
  if (url === '/v1/operations/operation_qa/readiness') payload = readiness;
  if (url === '/v1/mydash/operations/operation_qa/summary') payload = summary;
  if (url?.startsWith('/v1/mydash/operations/operation_qa/activity?')) payload = activity;
  if (url === '/v1/pilot/operations/operation_qa/next-action') payload = pilot;
  if (url === '/v1/operations/operation_qa/commercial') payload = commercial;
  if (url === '/v1/operations/operation_qa/claims') payload = claims;
  if (url === '/v1/operations/operation_qa/documents') payload = mode === 'documents-failure' ? undefined : [document];
  if (url === '/v1/soul/context') payload = context;
  if (url === '/v1/soul/consents') payload = consents;
  if (mode === 'documents-failure' && url === '/v1/operations/operation_qa/documents') {
    res.statusCode = 503; res.end(JSON.stringify({ error: { code: 'NOT_CONFIGURED' } })); return;
  }
  if (payload !== undefined) { res.end(JSON.stringify(payload)); return; }
  res.statusCode = 404; res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
});
backend.listen(0, '127.0.0.1');
await once(backend, 'listening');

const probe = createPortProbe();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = Number(process.env.FLOW2_PORT ?? probe.address().port);
await new Promise(resolve => probe.close(resolve));

const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, QEYNOX_API_URL: 'http://127.0.0.1:' + backend.address().port, NEXT_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
app.stdout.on('data', chunk => { logs += chunk; });
app.stderr.on('data', chunk => { logs += chunk; });
const cookie = 'qx-session=' + encodeURIComponent(JSON.stringify({ token, workspaceId: 'workspace_qa', expiresAt: '2099-01-01T00:00:00.000Z' }));
const url = 'http://127.0.0.1:' + port;

function cleanup() {
  app.kill();
  backend.closeAllConnections();
  backend.close();
}

try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (app.exitCode !== null) throw new Error(logs);
    try { await fetch(url + '/en'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 400)); }
  }
  assert.ok(ready, logs);

  if (serve) {
    console.log('FLOW2_QA_READY ' + url);
    await new Promise(resolve => process.once('SIGINT', resolve));
    process.exitCode = 0;
  } else {
    let assertions = 0;
    const page = async (path, authenticated = true) => {
      const response = await fetch(url + path, { headers: authenticated ? { cookie } : {} });
      assert.equal(response.status, 200, path);
      const html = await response.text();
      assert.ok(!html.includes(token), 'bearer token must never enter HTML');
      assertions += 2;
      return html;
    };
    const english = await page('/en/missions/operation_qa');
    if (variant === 'running') {
      for (const text of ['Recorded execution in progress', 'Active agents', 'Recherche documentaire', '1 / 3', 'EXECUTION_REQUESTED', 'Pending']) {
        assert.ok(english.includes(text), 'RUNNING missing: ' + text); assertions++;
      }
      console.log('PASS: ' + assertions + ' RUNNING-view assertions.');
    } else if (variant === 'result') {
      for (const text of ['A recorded result is available', 'QA evidence document', 'Delivered result', 'Results']) {
        assert.ok(english.includes(text), 'RESULT missing: ' + text); assertions++;
      }
      console.log('PASS: ' + assertions + ' RESULT-view assertions.');
    } else {
    for (const text of [
      'QA mission workspace', 'Évaluer la demande de pompage solaire au Maroc', 'Awaiting approval',
      'A human decision is waiting', 'Autoriser une collecte externe limitée', 'Review and evidence',
      'Veille marché', 'Recherche documentaire', 'Cadrer le marché marocain', '1 / 3', 'EXECUTION_REQUESTED', 'Latest recorded event',
      'Pilot guidance', 'QA evidence document', 'Secteur ciblé',
      'Énergie solaire', 'duplicate events ignored', 'Context inspector', 'Read availability',
    ]) { assert.ok(english.includes(text), 'EN missing: ' + text); assertions++; }
    // A21.07: each runtime prerequisite row is backed by its own verified live check.
    assert.ok(/data-ok="true" data-runtime-component="engine" data-verification="VERIFIED"/.test(english) && /data-ok="true" data-runtime-component="orchestrator" data-verification="VERIFIED"/.test(english), 'A21.07: runtime prerequisites show per-component verification'); assertions++;
    assert.ok(!english.includes('probe:') && !english.includes('evidenceRef'), 'A21.07: no evidence reference reaches the customer page'); assertions++;
    assert.ok(!english.includes('>WAITING_APPROVAL<'), 'raw status must be localized');
    assert.ok(!english.includes('>RUNNING<'), 'raw step state must be localized');

    const french = await page('/fr/missions/operation_qa');
    for (const text of ['Espace mission', 'Une décision humaine est attendue', 'Inspecteur contextuel', 'Secteur ciblé', 'Étapes', 'Activité enregistrée']) {
      assert.ok(french.includes(text), 'FR missing: ' + text); assertions++;
    }
    const anonymous = await page('/en/missions/operation_qa', false);
    assert.ok(anonymous.includes('SESSION_REQUIRED') && !anonymous.includes('Secteur ciblé'));
    assertions++;

    mode = 'documents-failure';
    const partial = await page('/fr/missions/operation_qa');
    assert.ok(partial.includes('NOT_CONFIGURED') && partial.includes('QA mission workspace'));
    assert.ok(!partial.includes('QA evidence document'), 'failed read must not display a document');
    assertions++;
    mode = 'normal';

    console.log('PASS: ' + assertions + ' mission-surface assertions (EN/FR, phase rail, current work, active capability, event dedupe/code, contextual inspector, read failure). QA fixtures only.');
    }
  }
} finally {
  if (!serve) cleanup();
}
