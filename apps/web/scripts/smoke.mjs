// Isolated HTTP contract fixtures for QA only. Never imported by the application.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer as createPortProbe } from 'node:net';

let mode = 'empty';
let capabilityReads = 0;
const token = 'q'.repeat(64);
const backend = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/auth/login' && req.method === 'POST') { res.end(JSON.stringify({ token, workspaceId: 'workspace_qa', expiresAt: '2099-01-01T00:00:00.000Z' })); return; }
  // MISSION A04 — public identity routes. The web layer calls these without a session, so the
  // fixture must answer them the way the real API does: no bearer header is sent.
  if (req.url === '/v1/identity/state') { assert.equal(req.headers.authorization, undefined); res.end(JSON.stringify({ verified: false, verifiedAt: null, delivery: 'NOT_CONFIGURED', deliveryReason: 'EMAIL_PROVIDER_NOT_CONFIGURED' })); return; }
  if (req.url?.startsWith('/v1/identity/recovery/inspect')) { res.end(JSON.stringify({ valid: false })); return; }
  if (req.url?.startsWith('/v1/identity/verification/inspect')) { res.end(JSON.stringify({ valid: false })); return; }
  if (req.url === '/v1/identity/recovery/request' && req.method === 'POST') { res.end(JSON.stringify({ sent: false, notSentReason: 'EMAIL_PROVIDER_NOT_CONFIGURED', issued: false })); return; }
  // MISSION A20 — public shared result routes (no bearer header sent).
  if (req.url === '/v1/public/shared-results/valid_qa_share_token_000000000000') {
    assert.equal(req.headers.authorization, undefined);
    res.end(JSON.stringify({
      share: {
        id: 'share_qa_01',
        label: 'External Board Memo',
        createdAt: '2026-11-18T12:00:00.000Z',
        expiresAt: '2026-11-25T12:00:00.000Z',
      },
      deliverable: true,
      verdict: 'Reviewed result. Verified findings below are supported by the cited sources at the recorded retrieval time.',
      verificationPosture: 'VERIFIED_DELIVERABLE',
      counts: { VERIFIED: 1, UNRESOLVED: 0, AWAITING_ASSESSMENT: 0, AI_INTERPRETATION: 0 },
      document: {
        id: 'document_qa_v2',
        version: 2,
        title: 'QA reviewed deliverable',
        objective: 'QA objective',
        scope: ['Morocco'],
        status: 'DELIVERABLE',
        createdAt: '2026-11-18T12:00:00.000Z',
        reviewedAt: '2026-11-18T12:00:00.000Z',
        hasPriorVersion: true,
        nextActions: ['Execute recommendation'],
        limitations: [],
        unresolved: [],
        citations: [{ sourceId: 'source_qa2', provider: 'QA provider', uri: 'https://example.org/supported', retrievedAt: '2026-11-18T11:55:00.000Z' }],
        findings: [{ claimId: 'claim_qa2', statement: 'QA supported finding', status: 'SUPPORTED', limitations: [], citations: [{ sourceId: 'source_qa2', provider: 'QA provider', uri: 'https://example.org/supported', retrievedAt: '2026-11-18T11:55:00.000Z' }] }],
      },
    }));
    return;
  }
  if (req.url === '/v1/public/shared-results/revoked_qa_share_token_0000000000') {
    assert.equal(req.headers.authorization, undefined);
    res.statusCode = 403;
    res.end(JSON.stringify({ error: { code: 'DENIED', message: 'Shared result link has been revoked' } }));
    return;
  }
  assert.equal(req.headers.authorization, `Bearer ${token}`);
  assert.equal(req.headers['x-qeynox-workspace'], 'workspace_qa');
  const operation = { id: 'operation_qa', title: 'QA mission workspace', status: 'RUNNING', version: 3, lastActivityAt: '2026-01-01T12:00:00.000Z' };
  const citation = { sourceId: 'source_qa', provider: 'QA source', uri: mode === 'unsafe-source' ? 'javascript:alert(1)' : 'https://example.org/evidence', retrievedAt: operation.lastActivityAt };
  // A07 — the fixture carries one claim that can be verified and one that cannot, so the reader has a
  // real distinction to display rather than an empty state that could hide a regression.
  const supportedCitation = { sourceId: 'source_qa2', provider: 'QA provider', uri: 'https://example.org/supported', retrievedAt: operation.lastActivityAt };
  const unsafeCitation = { sourceId: 'source_qa3', provider: 'QA unsafe source', uri: 'https://leaked:secret@example.org/private', retrievedAt: operation.lastActivityAt };
  const doc = { id: 'document_qa', operationId: operation.id, revisionId: 'revision_qa', version: 1, title: 'QA evidence document', objective: 'QA objective', status: 'PARTIAL', scope: [], nextActions: ['Review missing evidence'], limitations: ['QA limitation'], unresolved: ['claim_qa'], createdAt: operation.lastActivityAt, citations: [citation, supportedCitation, unsafeCitation], findings: [{ claimId: 'claim_qa', statement: 'QA finding', status: 'UNVERIFIED', sourceIds: ['source_qa'], attemptId: 'attempt_qa', limitations: ['Needs review'], citations: [citation] }, { claimId: 'claim_qa2', statement: 'QA supported finding', status: 'SUPPORTED', sourceIds: ['source_qa2'], attemptId: 'attempt_qa', limitations: [], citations: [supportedCitation] }, { claimId: 'claim_qa3', statement: 'QA unsafe-citation claim', status: 'SUPPORTED', sourceIds: ['source_qa3'], attemptId: 'attempt_qa', limitations: [], citations: [unsafeCitation] }] };
  let payload;
  if (req.url === '/v1/capabilities') {
    capabilityReads++;
    if (mode === 'capabilities-denied') { res.statusCode = 403; res.end(JSON.stringify({ error: { code: 'DENIED' } })); return; }
    if (mode === 'capabilities-malformed') { res.end(JSON.stringify({ slots: 'invalid' })); return; }
    payload = { total: 8, active: 1, available: 1, slots: Array.from({ length: 8 }, (_, index) => index === 0
      ? { slot: 1, status: 'ACTIVE', available: true, operationalState: 'OPERATIONAL', capability: { id: 'capability_qa', version: 1, name: 'QA evidence research', purpose: 'QA fixture', scope: [], maximumSteps: 3, maximumToolCalls: 2, externalActions: false, providerReady: true, missingProviders: [], profileReady: true, policyReady: true, missingPolicies: [], operationalState: 'OPERATIONAL', isExecutable: true } }
      : { slot: index + 1, status: 'UNCONFIGURED', available: false, operationalState: 'BLOCKED', capability: null }) };
  }
  if (req.url === '/v1/operations/operation_qa') payload = operation;
  if (req.url === '/v1/mydash/operations/operation_qa/summary') payload = { operationId: operation.id, status: 'RUNNING', stepCount: 3, completedSteps: 1, pendingApprovals: 0, lastSequence: 1 };
  if (req.url === '/v1/operations/operation_qa/timeline') payload = [{ id: 'event_qa', kind: 'EXECUTION_REQUESTED', occurredAt: operation.lastActivityAt }];
  if (req.url?.startsWith('/v1/mydash/operations/operation_qa/activity?')) payload = { events: [{ id: 'envelope_qa', eventId: 'event_qa', sequence: 1, kind: 'EXECUTION_REQUESTED', occurredAt: operation.lastActivityAt }], nextCursor: 1, transport: 'POLLING' };
  if (req.url === '/v1/pilot/operations/operation_qa/next-action') payload = { operationId: operation.id, status: 'RUNNING', action: 'WAIT', reason: 'Based on recorded operation state only' };
  if (req.url === '/v1/pilot/overview') payload = [operation];
  // MISSION A05 — the view now reports real engine readiness instead of a hardcoded literal, so the
  // fixture states an unconfigured engine and the page must say so rather than claim AI.
  if (req.url === '/v1/soul/onboarding') payload = {
    status: 'COMPLETED', step: 'DONE', locale: 'en',
    progress: { answered: 8, total: 8 },
    consent: { granted: true, consentId: 'consent_qa', purpose: 'Soul onboarding — consented context', scopes: ['context:read', 'context:write'], grantedAt: operation.lastActivityAt },
    startedAt: operation.lastActivityAt, updatedAt: operation.lastActivityAt, completedAt: operation.lastActivityAt,
    aiAvailable: false, aiReason: 'NO_ATTESTATION', guidanceAvailable: false,
  };
  // The consent contract exposes `scopes` (plural). A fixture using the wrong key must not be able
  // to crash the page, and must not silently masquerade as a valid consent either.
  if (req.url === '/v1/soul/consents') payload = [{ id: 'consent_qa', purpose: 'Soul onboarding — consented context', scopes: ['context:read', 'context:write'], grantedAt: operation.lastActivityAt }];
  if (req.url === '/v1/operations/operation_qa/claims') payload = [];
  if (req.url === '/v1/operations/operation_qa/vault-documents' || req.url === '/v1/documents') payload = [];
  // MISSION A08 — a commercial state with an accepted paid order, so the payment panel has something
  // real to render. Without it the panel would be untestable in this fixture.
  if (req.url === '/v1/operations/operation_qa/commercial' && mode.startsWith('payment-')) {
    payload = {
      operationId: operation.id, revisionId: 'revision_qa', offers: [], quotes: [],
      order: { id: 'order_qa', state: 'PAYMENT_REQUIRED', amountMinor: 2500, currency: 'USD', createdAt: operation.lastActivityAt },
      executionAuthorized: false, payment: { required: true, state: 'PAYMENT_REQUIRED' },
    };
    res.end(JSON.stringify(payload)); return;
  }
  if (['/v1/operations/operation_qa/plan', '/v1/operations/operation_qa/readiness', '/v1/operations/operation_qa/commercial'].includes(req.url)) {
    res.statusCode = 503; res.end(JSON.stringify({ error: { code: 'NOT_CONFIGURED' } })); return;
  }
  // MISSION A08 — payment status. The fixture reports a real recorded state; it never claims success.
  // MISSION A21.01 — the real API can only return FROZEN payment views now (both supported commerce modes
  // freeze payments), so every fixture mirrors that contract: a `commerce` block, no checkout, no link.
  if (req.url === '/v1/operations/operation_qa/payment') {
    const commerce = (frozenMode) => ({ mode: frozenMode, paymentsAvailable: false, checkoutAvailable: false, refundsAvailable: false, betaFree: frozenMode === 'BETA_FREE', reason: 'PAYMENTS_FROZEN' });
    const frozen = { canStartCheckout: false, providerConfigured: false, blockedReason: 'PAYMENTS_FROZEN' };
    payload = mode === 'payment-authorized'
      ? {
          orderId: 'order_qa', orderState: 'AUTHORIZED', refunds: [], executionAuthorized: true, ...frozen,
          payment: { id: 'payment_qa', status: 'AUTHORIZED', amountMinor: 2500, currency: 'USD', capturedMinor: 0, refundedMinor: 0, checkoutUrl: null, expiresAt: null, failureCode: null },
          commerce: commerce('PAYMENTS_DISABLED'),
        }
      : mode === 'payment-frozen-disabled'
        ? { orderId: 'order_qa', orderState: 'PAYMENT_REQUIRED', payment: null, refunds: [], executionAuthorized: false, ...frozen, commerce: commerce('PAYMENTS_DISABLED') }
        : mode === 'payment-frozen-beta'
          ? { orderId: 'order_qa', orderState: 'PAYMENT_REQUIRED', payment: null, refunds: [], executionAuthorized: false, ...frozen, commerce: commerce('BETA_FREE') }
          : mode === 'payment-legacy-unfrozen'
            // A pre-A21 response shape (no `commerce` block) must be rejected, never rendered as payable.
            ? {
                orderId: 'order_qa', orderState: 'PAYMENT_REQUIRED', refunds: [], executionAuthorized: false,
                canStartCheckout: true, blockedReason: null, providerConfigured: true,
                payment: { id: 'payment_qa', status: 'FAILED', amountMinor: 2500, currency: 'USD', capturedMinor: 0, refundedMinor: 0, checkoutUrl: 'https://checkout.stripe.test/qa', expiresAt: null, failureCode: 'card_declined' },
              }
            : {
                orderId: 'order_qa', orderState: 'PAYMENT_REQUIRED', refunds: [], executionAuthorized: false, ...frozen,
                payment: { id: 'payment_qa', status: 'FAILED', amountMinor: 2500, currency: 'USD', capturedMinor: 0, refundedMinor: 0, checkoutUrl: null, expiresAt: null, failureCode: 'card_declined' },
                commerce: commerce('PAYMENTS_DISABLED'),
              };
    res.end(JSON.stringify(payload)); return;
  }
  if (req.url === '/v1/operations/operation_qa/documents') payload = [doc];
  if (req.url === '/v1/operations/operation_qa/documents/document_qa') payload = doc;
  if (req.url === '/v1/soul/context') payload = [{ id: 'fact_qa', key: 'QA preference', value: 'French', consentId: 'consent_qa', updatedAt: operation.lastActivityAt }];
  if (mode === 'section-failure' && req.url?.endsWith('/documents')) { res.statusCode = 503; res.end(JSON.stringify({ error: { code: 'NOT_CONFIGURED' } })); return; }
  // MISSION A07 — PDF is now a first-class export format, alongside JSON and HTML.
  if (req.url?.endsWith('/export/json') || req.url?.endsWith('/export/html') || req.url?.endsWith('/export/pdf')) {
    const format = req.url.slice(req.url.lastIndexOf('/') + 1);
    res.end(JSON.stringify({ artifactId: 'artifact_qa', sha256: 'a'.repeat(64), format, contentType: format === 'pdf' ? 'application/pdf' : 'text/plain' }));
    return;
  }
  if (req.url?.endsWith('/artifacts/artifact_qa')) { res.end(JSON.stringify({ url: 'https://example.org/qa-only-artifact' })); return; }
  // MISSION A20 — Global Atlas Library routes.
  if (req.url === '/v1/results/document_qa/shares') {
    payload = [];
  } else if (req.url?.startsWith('/v1/results/document_qa')) {
    payload = {
      document: { ...doc, workspaceId: 'workspace_qa', version: 2, priorId: 'document_qa_v1' },
      operation: { id: operation.id, title: operation.title, status: operation.status, lastActivityAt: operation.lastActivityAt, lastErrorCode: null, currentRevisionId: 'revision_qa' },
      deliverable: false,
      verdict: 'Partial: at least one finding is unresolved.',
      verificationPosture: 'PARTIALLY_VERIFIED',
      counts: { VERIFIED: 1, UNRESOLVED: 2, AWAITING_ASSESSMENT: 0, AI_INTERPRETATION: 0 },
      isLatestVersion: true,
      latestDocumentId: 'document_qa',
      previousVersionDocumentId: 'document_qa_v1',
      nextVersionDocumentId: null,
      versions: [
        { id: 'document_qa', version: 2, status: 'PARTIAL', title: doc.title, createdAt: operation.lastActivityAt, reviewedAt: null, isLatestVersion: true, verificationPosture: 'PARTIALLY_VERIFIED', counts: { VERIFIED: 1, UNRESOLVED: 2, AWAITING_ASSESSMENT: 0, AI_INTERPRETATION: 0 }, citationCount: 3 },
        { id: 'document_qa_v1', version: 1, status: 'DRAFT', title: 'QA evidence document v1', createdAt: '2026-01-01T10:00:00.000Z', reviewedAt: null, isLatestVersion: false, verificationPosture: 'UNVERIFIED', counts: { VERIFIED: 0, UNRESOLVED: 0, AWAITING_ASSESSMENT: 0, AI_INTERPRETATION: 0 }, citationCount: 0 },
      ],
      comparison: {
        baseDocumentId: 'document_qa_v1',
        baseVersion: 1,
        baseStatus: 'DRAFT',
        baseCreatedAt: '2026-01-01T10:00:00.000Z',
        targetDocumentId: 'document_qa',
        targetVersion: 2,
        targetStatus: 'PARTIAL',
        targetCreatedAt: operation.lastActivityAt,
        statusChanged: true,
        verifiedDelta: 1,
        unresolvedDelta: 2,
        awaitingDelta: 0,
        citationDelta: 3,
        scopeAdded: [],
        scopeRemoved: [],
        addedFindings: [{ claimId: 'claim_qa2', statement: 'QA supported finding', status: 'SUPPORTED', findingClass: 'VERIFIED' }],
        removedFindings: [],
        changedFindings: [],
      },
      artifacts: [{ id: 'artifact_qa', format: 'pdf', contentType: 'application/pdf', sha256: 'a'.repeat(64), size: 2048, state: 'AVAILABLE', createdAt: operation.lastActivityAt }],
      artifactStoreConfigured: true,
      canExportNew: true,
      canManageShares: true,
      activeShareCount: 0,
    };
  } else if (req.url?.startsWith('/v1/results')) {
    payload = mode === 'empty'
      ? { items: [], nextCursor: null, limit: 20, totalCount: 0, workspaceDocumentCount: 0, missions: [], failedOperations: [], artifactStoreConfigured: false, canManageShares: true }
      : {
          items: [{
            id: 'document_qa',
            operationId: operation.id,
            operationTitle: operation.title,
            operationStatus: operation.status,
            operationLastErrorCode: null,
            revisionId: 'revision_qa',
            version: 2,
            latestVersionForOperation: 2,
            isLatestVersion: true,
            previousVersionDocumentId: 'document_qa_v1',
            latestDocumentId: 'document_qa',
            title: doc.title,
            objective: doc.objective,
            status: 'PARTIAL',
            deliverable: false,
            verdict: 'Partial: at least one finding is unresolved.',
            verificationPosture: 'PARTIALLY_VERIFIED',
            counts: { VERIFIED: 1, UNRESOLVED: 2, AWAITING_ASSESSMENT: 0, AI_INTERPRETATION: 0 },
            provenance: { citationCount: 3, verifiableCitationCount: 2, providers: ['QA source', 'QA provider'], latestRetrievedAt: operation.lastActivityAt },
            availableExports: ['pdf'],
            pendingExportCount: 0,
            activeShareCount: 0,
            createdAt: operation.lastActivityAt,
            reviewedAt: null,
            lastUpdatedAt: operation.lastActivityAt,
          }],
          nextCursor: null,
          limit: 20,
          totalCount: 1,
          workspaceDocumentCount: 2,
          missions: [{ operationId: operation.id, title: operation.title, status: operation.status, documentCount: 2, latestVersion: 2 }],
          failedOperations: [{ operationId: 'operation_failed_qa', title: 'QA failed mission without result', status: 'FAILED', lastActivityAt: operation.lastActivityAt, lastErrorCode: 'CONNECTOR_TIMEOUT', documentCount: 0 }],
          artifactStoreConfigured: true,
          canManageShares: true,
        };
  }
  if (payload !== undefined) { res.end(JSON.stringify(payload)); return; }
  assert.equal(req.url, '/v1/mydash/recent?limit=30');
  if (mode === 'denied') { res.statusCode = 403; res.end(JSON.stringify({ error: { code: 'DENIED' } })); }
  else if (mode === 'malformed') res.end(JSON.stringify([{ operationId: 'invalid' }]));
  // A06: an interrupted operation now carries attention STALLED and must appear in the decision list
  // instead of silently disappearing with attention NONE.
  else if (mode === 'interrupted') res.end(JSON.stringify([{ operationId: 'operation_qa', title: 'QA interrupted fixture', status: 'INTERRUPTED', attention: 'STALLED', lastActivityAt: '2026-01-01T12:00:00.000Z' }]));
  else res.end(JSON.stringify(mode === 'empty' ? [] : [{ operationId: 'operation_qa', title: 'QA contract fixture', status: 'DRAFT', lastActivityAt: '2026-01-01T12:00:00.000Z' }]));
});
backend.listen(0, '127.0.0.1');
await once(backend, 'listening');
const probe = createPortProbe();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = process.env.QEYNOX_SMOKE_INTERACTIVE === '1' ? 3137 : probe.address().port;
await new Promise(resolve => probe.close(resolve));
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, QEYNOX_API_URL: `http://127.0.0.1:${backend.address().port}`, NEXT_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
app.stdout.on('data', chunk => { logs += chunk; });
app.stderr.on('data', chunk => { logs += chunk; });
const cookie = `qx-session=${encodeURIComponent(JSON.stringify({ token, workspaceId: 'workspace_qa', expiresAt: '2099-01-01T00:00:00.000Z' }))}`;
let assertions = 0;
async function page(path, authenticated = false) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: authenticated ? { cookie } : {} });
  assert.equal(response.status, 200); assertions++;
  const html = await response.text();
  assert.ok(!html.includes(token), 'bearer token must never enter HTML'); assertions++;
  return html;
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (app.exitCode !== null) throw new Error(logs);
    try { await fetch(`http://127.0.0.1:${port}/en`); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  assert.ok(ready, logs);
  if (process.env.QEYNOX_SMOKE_INTERACTIVE === '1') {
    console.log(`QA FIXTURE ONLY: http://127.0.0.1:${port}/en/account (any test email/password; no real credentials).`);
    await new Promise(resolve => process.once('SIGINT', resolve));
    process.exitCode = 0;
  } else {
  const home = await page('/en');
  assert.match(home, /A useful business result, not agent theatre/); assertions++;
  assert.match(home, /rel="canonical"/); assertions++;
  assert.match(home, /name="description"/); assertions++;
  for (const path of ['/en/how-it-works','/en/manifesto','/en/contact','/en/legal/notice','/en/legal/privacy','/en/legal/terms','/en/legal/cookies','/fr/how-it-works']) await page(path);
  // MISSION A04 — customer identity routes. Anonymous visitors get real pages (never a blank or a
  // redirect loop), and the recovery/verification screens state their own dead-link condition.
  for (const path of ['/en/account/register','/fr/account/register']) await page(path);
  const register = await page('/en/account/register');
  assert.match(register, /Create an account/); assertions++;
  assert.match(register, /minlength="12"/i); assertions++;
  for (const path of ['/en/account/recover','/fr/account/recover']) await page(path);
  const deadReset = await page('/en/account/reset?token=' + 'x'.repeat(64));
  assert.match(deadReset, /no longer valid/); assertions++;
  const deadVerify = await page('/en/account/verify?token=' + 'x'.repeat(64));
  assert.match(deadVerify, /no longer valid/); assertions++;
  // An invalid token is refused BEFORE the action is offered: the state is visible up front.
  const badVerify = await page('/en/account/verify?token=' + 'y'.repeat(64));
  assert.ok(!badVerify.includes('Confirm address'), 'an invalid verification token never renders a confirm button'); assertions++;
  const sitemap = await (await fetch(`http://127.0.0.1:${port}/sitemap.xml`)).text();
  assert.match(sitemap, /\/en\/how-it-works/); assertions++;
  assert.match(sitemap, /\/fr\/how-it-works/); assertions++;
  assert.doesNotMatch(sitemap, /\/mydash|\/missions|\/admin/); assertions++;
  const robots = await (await fetch(`http://127.0.0.1:${port}/robots.txt`)).text();
  assert.match(robots, /Disallow: \/admin/); assertions++;
  assert.match(await page('/fr'), /<html lang="fr"/); assertions++;
  assert.match(await page('/en/mydash'), /Sign in to view or save/); assertions++;
  const anonymousCapabilities = await page('/en/capabilities');
  assert.match(anonymousCapabilities, /Sign in to view or save your missions/); assertions++;
  assert.doesNotMatch(anonymousCapabilities, /QA evidence research/); assertions++;
  assert.equal(capabilityReads, 0, 'anonymous page must not request the catalogue'); assertions++;
  const authenticatedCapabilities = await page('/en/capabilities', true);
  assert.match(authenticatedCapabilities, /QA evidence research/); assertions++;
  assert.match(authenticatedCapabilities, /No capability is configured for this slot/); assertions++;
  assert.equal(capabilityReads, 1); assertions++;
  mode = 'capabilities-denied';
  const deniedCapabilities = await page('/en/capabilities', true);
  assert.match(deniedCapabilities, /Access was denied/); assertions++;
  assert.doesNotMatch(deniedCapabilities, /QA evidence research/); assertions++;
  mode = 'capabilities-malformed';
  const malformedCapabilities = await page('/en/capabilities', true);
  assert.match(malformedCapabilities, /request could not be completed/); assertions++;
  assert.doesNotMatch(malformedCapabilities, /QA evidence research/); assertions++;
  mode = 'empty';
  assert.match(await page('/en/mydash', true), /No recorded operations were returned/); assertions++;
  mode = 'interrupted';
  const interruptedDash = await page('/en/mydash', true);
  assert.match(interruptedDash, /Interrupted — needs a decision/); assertions++;
  mode = 'loaded';
  const loaded = await page('/en/mydash', true);
  assert.match(loaded, /QA contract fixture/); assertions++;
  assert.match(loaded, />Draft<\/span>/); assertions++;
  mode = 'denied';
  assert.match(await page('/en/mydash', true), /Access was denied/); assertions++;
  mode = 'malformed';
  assert.match(await page('/en/mydash', true), /request could not be completed/); assertions++;
  const unknown = await fetch(`http://127.0.0.1:${port}/es`);
  assert.equal(unknown.status, 404); assertions++;
  // A05: an unconfigured engine must never be presented as AI. The badge names the fallback and the
  // real reason, and the old untruthful PRE_MISSION_CONTRACT string is gone.
  const soul = await page('/en/soul', true);
  assert.match(soul, /Deterministic guidance/); assertions++;
  assert.match(soul, /NO_ATTESTATION/); assertions++;
  assert.doesNotMatch(soul, /PRE_MISSION_CONTRACT/); assertions++;
  assert.doesNotMatch(soul, /AI: available/); assertions++;
  const mission = await page('/en/missions/operation_qa', true);
  for (const text of ['QA mission workspace', '1 / 3', 'EXECUTION_REQUESTED', 'QA evidence document', 'QA preference', 'Pilot']) { assert.ok(mission.includes(text), text); assertions++; }
  const document = await page('/en/missions/operation_qa/results/document_qa', true);
  for (const text of ['QA finding', 'QA limitation', 'https://example.org/evidence']) { assert.ok(document.includes(text), text); assertions++; }
  assert.ok(!document.includes('>UNVERIFIED<') && !document.includes('>PARTIAL<'), 'raw document/finding enums must be localized'); assertions++;
  // MISSION A07 — the reader separates classes structurally, and never shows an unreviewed claim as a
  // verified conclusion. These are the load-bearing assertions of the whole mission.
  for (const id of ['atlas-verified', 'atlas-unresolved', 'atlas-awaiting', 'atlas-provenance', 'atlas-review']) { assert.ok(document.includes('id="' + id + '"'), 'the reader exposes section ' + id); assertions++; }
  assert.ok(document.includes('Awaiting human review') || document.includes('Partial: at least one finding is unresolved'), 'an unreviewed document states it is not a delivered result'); assertions++;
  assert.ok(!/Reviewed result\./.test(document), 'an unreviewed document is never presented as a reviewed result'); assertions++;
  assert.ok(document.includes('QA supported finding') && document.includes('QA unsafe-citation claim'), 'both claims are rendered'); assertions++;
  // A SUPPORTED claim citing only a credential-bearing URL is demoted, and its password is redacted.
  assert.ok(!document.includes('leaked:secret@'), 'embedded credentials are never rendered in the reader'); assertions++;
  assert.ok(!document.includes('href="https://leaked'), 'a credential-bearing URL never becomes a link'); assertions++;
  // The verified section holds exactly the one genuinely verifiable finding.
  const verifiedSection = document.slice(document.indexOf('id="atlas-verified"'), document.indexOf('id="atlas-unresolved"'));
  assert.ok(verifiedSection.includes('QA supported finding'), 'the verifiable finding appears in the verified section'); assertions++;
  assert.ok(!verifiedSection.includes('QA unsafe-citation claim') && !verifiedSection.includes('QA finding'), 'no unverifiable claim appears in the verified section'); assertions++;
  // Every export format is offered, including the new PDF one.
  for (const format of ['pdf', 'html', 'json']) { assert.ok(document.includes('value="' + format + '"'), 'the reader offers the ' + format + ' export'); assertions++; }
  assert.ok(document.includes('PDF'), 'the export note names the PDF format'); assertions++;
  const frenchDocument = await page('/fr/missions/operation_qa/results/document_qa', true);
  assert.ok(frenchDocument.includes('En attente d’évaluation') && frenchDocument.includes('Partiel'), 'the French reader is translated'); assertions++;
  assert.ok(!frenchDocument.includes('>UNVERIFIED<'), 'the French reader does not leak raw enums'); assertions++;
  // MISSION A08 + A21.01 — a recorded failed payment stays visible and is never read as paid; under the
  // payment freeze it is history only: no retry, resume or checkout action is offered.
  mode = 'payment-failed';
  const payFailed = await page('/en/missions/operation_qa', true);
  assert.ok(payFailed.includes('Declined'), 'a declined payment is named in the page'); assertions++;
  assert.ok(!/Paid<\/span>/.test(payFailed), 'a declined payment is never shown as paid'); assertions++;
  assert.ok(payFailed.includes('Payments are currently disabled'), 'the frozen PAYMENTS_DISABLED state is stated plainly'); assertions++;
  assert.ok(payFailed.includes('shown for reference only'), 'recorded payment history is labelled read-only'); assertions++;
  assert.ok(!/Try again<\/button>|Resume checkout|Continue to secure checkout/.test(payFailed), 'no retry or checkout action is offered while frozen'); assertions++;
  assert.ok(!payFailed.includes('checkout.stripe'), 'no hosted checkout link is rendered while frozen'); assertions++;
  mode = 'payment-frozen-disabled';
  const payDisabled = await page('/en/missions/operation_qa', true);
  assert.ok(payDisabled.includes('Payments are currently disabled') && payDisabled.includes('data-commerce-mode="PAYMENTS_DISABLED"'), 'PAYMENTS_DISABLED renders its frozen state'); assertions++;
  assert.ok(!/Continue to secure checkout/.test(payDisabled), 'no checkout button is offered when payments are disabled'); assertions++;
  assert.ok(payDisabled.includes('payments are frozen on the server'), 'the payment-required notice names the freeze, not a missing provider'); assertions++;
  mode = 'payment-frozen-beta';
  const payBeta = await page('/en/missions/operation_qa', true);
  assert.ok(payBeta.includes('free beta') && payBeta.includes('data-commerce-mode="BETA_FREE"'), 'BETA_FREE renders the free-beta frozen state'); assertions++;
  assert.ok(!/Continue to secure checkout/.test(payBeta), 'no checkout button is offered in free beta'); assertions++;
  const payBetaFr = await page('/fr/missions/operation_qa', true);
  assert.ok(payBetaFr.includes('bêta gratuite') && !/Continuer vers le paiement sécurisé/.test(payBetaFr), 'the French free-beta state is translated and offers no checkout'); assertions++;
  mode = 'payment-legacy-unfrozen';
  const payLegacy = await page('/en/missions/operation_qa', true);
  assert.ok(payLegacy.includes('Payment status unavailable'), 'a response without the commerce block is rejected, not rendered'); assertions++;
  assert.ok(!/Continue to secure checkout|Try again<\/button>/.test(payLegacy) && !payLegacy.includes('checkout.stripe'), 'a legacy payable response never yields a checkout action'); assertions++;
  mode = 'section-failure';
  const partial = await page('/fr/missions/operation_qa', true);
  assert.ok(partial.includes('NOT_CONFIGURED') && partial.includes('QA mission workspace')); assertions++;
  const anonymousMission = await page('/en/missions/operation_qa');
  assert.ok(anonymousMission.includes('SESSION_REQUIRED') && !anonymousMission.includes('QA preference')); assertions++;
  mode = 'unsafe-source';
  const unsafeSource = await page('/en/missions/operation_qa/results/document_qa', true);
  assert.ok(!unsafeSource.includes('href="javascript:'), 'a javascript: citation is never a link'); assertions++;
  assert.ok(unsafeSource.includes('non verifiable') || unsafeSource.includes('not verifiable') || unsafeSource.includes('No citation available'), 'an unverifiable citation is labelled as such'); assertions++;
  // MISSION A20 — Global Atlas Library: EN/FR library, filters, version diff, controlled share & robots.
  mode = 'empty';
  const emptyResults = await page('/en/results', true);
  assert.ok(emptyResults.includes('Results library') && emptyResults.includes('No Atlas result has been recorded in this workspace yet'), 'empty Atlas Library renders honest empty state'); assertions++;
  const anonResults = await page('/en/results');
  assert.ok(anonResults.includes('Sign in to view or save your missions.') && !anonResults.includes('QA evidence document'), 'unauthenticated /en/results enforces session boundary'); assertions++;
  mode = 'loaded';
  const loadedResultsEn = await page('/en/results', true);
  for (const text of ['Results library', 'QA evidence document', 'Partially verified', 'QA provider', 'QA failed mission without result', 'CONNECTOR_TIMEOUT']) {
    assert.ok(loadedResultsEn.includes(text), 'EN Atlas Library includes ' + text); assertions++;
  }
  const loadedResultsFr = await page('/fr/results', true);
  for (const text of ['Bibliothèque des résultats', 'Partiellement vérifié', 'Résultats']) {
    assert.ok(loadedResultsFr.includes(text), 'FR Atlas Library includes ' + text); assertions++;
  }
  const atlasDetail = (await page('/en/results/document_qa', true)).replaceAll('<!-- -->', '');
  for (const text of ['Version comparison', 'v1', 'v2', 'Previous version', 'Controlled external sharing', 'PDF']) {
    assert.ok(atlasDetail.includes(text), 'Atlas Library detail includes ' + text); assertions++;
  }
  const publicShared = await page('/en/results/shared/valid_qa_share_token_000000000000');
  assert.ok(publicShared.includes('noindex, nofollow'), 'shared result page sets noindex, nofollow'); assertions++;
  assert.ok(publicShared.includes('QA reviewed deliverable') && publicShared.includes('External Board Memo'), 'shared result renders canonical deliverable'); assertions++;
  assert.ok(!publicShared.includes('workspace_qa'), 'shared result never leaks workspaceId'); assertions++;
  const revokedShared = await page('/en/results/shared/revoked_qa_share_token_0000000000');
  assert.ok(revokedShared.includes('This shared result link has expired or been revoked') && !revokedShared.includes('QA reviewed deliverable'), 'revoked share link fails closed'); assertions++;
  const robotsTxt = await page('/robots.txt');
  assert.ok(robotsTxt.includes('Disallow: /results') && robotsTxt.includes('Disallow: /*/results'), 'robots.txt disallows /results routes'); assertions++;
  console.log(`PASS: ${assertions} HTTP assertions; EN/FR, session boundary, genuine empty/loaded/denied/malformed states. QA fixtures only; no database or agent runtime used.`);
  }
} finally {
  app.kill();
  backend.closeAllConnections();
  backend.close();
}
