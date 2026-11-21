// Isolated HTTP contract fixtures for QA only. Never imported by the application.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer as createPortProbe } from 'node:net';

let mode = 'empty';
// MISSION A21.04 — which free-beta journey the fixture API reports (independent of `mode`).
let beta = 'active';
// MISSION A21.05 — which registration policy the fixture API reports: open | invite | closed | malformed | error.
let registration = 'open';
let registrationPolicyReads = 0;
const journeyAccount = {
  status: 'ACTIVE', expiresAt: '2026-12-31T23:59:00.000Z', invitationExpiresAt: null, activatedAt: '2026-11-01T09:00:00.000Z',
  missionQuota: 5, missionsUsed: 2, missionsRemaining: 3, activeMissions: 0, concurrentLimit: 2,
  providerBudgetMinor: 5000, providerBudgetRemainingMinor: 4200, currency: 'EUR', quotaReason: null, canActivate: false,
};
const noGrant = { status: 'NOT_ENROLLED', expiresAt: null, invitationExpiresAt: null, activatedAt: null, missionQuota: null, missionsUsed: null, missionsRemaining: null, activeMissions: 0, concurrentLimit: null, providerBudgetMinor: null, providerBudgetRemainingMinor: null, currency: null, quotaReason: null, canActivate: false };
function betaJourney(kind) {
  const enabled = kind !== 'not-configured';
  const runtime = kind === 'runtime' ? { canExecute: false, state: 'BLOCKED' } : { canExecute: true, state: 'OPERATIONAL' };
  const accounts = {
    active: [journeyAccount, 'ACTIVE'],
    'not-configured': [journeyAccount, 'NOT_CONFIGURED'],
    'not-enrolled': [noGrant, 'NOT_ENROLLED'],
    invited: [{ ...journeyAccount, status: 'INVITED', activatedAt: null, invitationExpiresAt: '2026-11-28T12:00:00.000Z', missionsUsed: 0, missionsRemaining: 5, providerBudgetRemainingMinor: 5000, canActivate: true }, 'INVITATION_PENDING'],
    expired: [{ ...journeyAccount, status: 'EXPIRED', expiresAt: '2026-11-10T18:00:00.000Z' }, 'EXPIRED'],
    revoked: [{ ...journeyAccount, status: 'REVOKED' }, 'REVOKED'],
    quota: [{ ...journeyAccount, missionsUsed: 5, missionsRemaining: 0, quotaReason: 'MISSIONS' }, 'QUOTA_EXHAUSTED'],
    runtime: [journeyAccount, 'RUNTIME_UNAVAILABLE'],
  };
  const [account, state] = accounts[kind];
  return {
    workspaceId: 'workspace_qa', state, canLaunch: state === 'ACTIVE',
    freeBeta: { enabled, mode: enabled ? 'BETA_FREE' : 'PAYMENTS_DISABLED', cardRequired: false, paymentsAvailable: false, amountDueTodayMinor: 0, waiverPercent: enabled ? 100 : null, waiverApplies: enabled && account.status === 'ACTIVE' },
    account, runtime,
  };
}
const qaService = (offerId, label, amountMinor, isExplicitlyFree) => ({
  offerId, version: 1, label, displayName: label, amountMinor, currency: 'EUR', isExplicitlyFree, taxPolicy: 'CONFIGURED',
  scope: ['QA scope'], exclusions: [], regions: ['GLOBAL'], locales: ['en', 'fr'], termsVersion: '2026-11-a16', deliverableSchemaVersion: 1,
  capabilityIds: ['capability_qa'], availability: { operationalState: 'BLOCKED', isExecutable: false, blockers: ['RUNTIME_NOT_OPERATIONAL'] },
  requestable: false, contractKey: null, unavailableReason: 'CAPABILITY_NOT_CONFIGURED',
});
let capabilityReads = 0;
const token = 'q'.repeat(64);
const backend = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  // A21.04 — interactive QA only: switch the fixture state (used by the screenshot run). Never enabled
  // in the asserted smoke run, and never part of the application.
  if (process.env.QEYNOX_SMOKE_INTERACTIVE === '1' && req.url?.startsWith('/__qa/state?')) {
    const query = new URL(req.url, 'http://fixture').searchParams;
    if (query.get('mode')) mode = query.get('mode');
    if (query.get('beta')) beta = query.get('beta');
    if (query.get('registration')) registration = query.get('registration');
    res.end(JSON.stringify({ mode, beta, registration })); return;
  }
  // MISSION A21.05 — the public registration policy. Read without a session, like the real API.
  if (req.url === '/v1/auth/registration-policy') {
    assert.equal(req.headers.authorization, undefined); registrationPolicyReads++;
    const policies = {
      open: { mode: 'OPEN', acceptingRegistrations: true, invitationRequired: false },
      invite: { mode: 'INVITE_ONLY', acceptingRegistrations: true, invitationRequired: true },
      closed: { mode: 'CLOSED', acceptingRegistrations: false, invitationRequired: false },
      // Internally inconsistent: the web must refuse it rather than guess.
      malformed: { mode: 'CLOSED', acceptingRegistrations: true, invitationRequired: false },
    };
    if (registration === 'error') { res.statusCode = 500; res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } })); return; }
    res.end(JSON.stringify(policies[registration])); return;
  }
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
  // MISSION A21.04 — the free-beta journey read model and the service catalogue.
  if (req.url === '/v1/workspaces/current/beta-access/journey') {
    if (beta === 'unavailable') { res.statusCode = 503; res.end(JSON.stringify({ error: { code: 'NOT_CONFIGURED' } })); return; }
    // A response that would ask for a card must be rejected by the web, never rendered as free beta.
    if (beta === 'malformed') { const value = betaJourney('active'); res.end(JSON.stringify({ ...value, freeBeta: { ...value.freeBeta, cardRequired: true } })); return; }
    res.end(JSON.stringify(betaJourney(beta))); return;
  }
  if (req.url === '/v1/services') { res.end(JSON.stringify([qaService('offer_strategy_qa', 'QA Strategy Pack', 29000, false), qaService('offer_research_qa', 'QA Research Pack', 0, true)])); return; }
  if (req.url === '/v1/services/offer_strategy_qa') {
    res.end(JSON.stringify({ ...qaService('offer_strategy_qa', 'QA Strategy Pack', 29000, false), capabilities: [], deployment: null })); return;
  }
  // A21.04: a mission awaiting quote acceptance is READY (not yet launched), so the launch card is shown.
  const operation = { id: 'operation_qa', title: 'QA mission workspace', status: mode === 'payment-beta-quote' ? 'READY' : 'RUNNING', version: 3, lastActivityAt: '2026-01-01T12:00:00.000Z' };
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
    // MISSION A21.03 — free-beta authorization fixtures. The list price stays on the order; 0 is due.
    const betaAuthorization = (valid, denial, status = 'AUTHORIZED') => ({
      id: 'beta_auth_qa', basis: 'FREE_BETA', grantId: 'grant_qa', status, revisionId: 'revision_qa', offerId: 'offer_qa', offerVersion: 1,
      termsVersion: 'terms_qa', listAmountMinor: 29000, currency: 'EUR', amountDueNowMinor: 0, authorizedAt: operation.lastActivityAt,
      deliveredAt: status === 'DELIVERED' ? operation.lastActivityAt : null, valid, denial,
    });
    const betaOrder = state => ({ id: 'order_qa', state, amountMinor: 29000, currency: 'EUR', createdAt: operation.lastActivityAt });
    if (mode === 'payment-beta-authorized') payload = { ...payload, order: betaOrder('BETA_AUTHORIZED'), executionAuthorized: true, payment: { required: false, state: 'BETA_AUTHORIZED' }, betaAuthorization: betaAuthorization(true, null), betaAuthorizationAvailable: false };
    if (mode === 'payment-beta-invalid') payload = { ...payload, order: betaOrder('BETA_AUTHORIZED'), executionAuthorized: false, payment: { required: false, state: 'BETA_AUTHORIZED' }, betaAuthorization: betaAuthorization(false, 'GRANT_REVOKED'), betaAuthorizationAvailable: false };
    if (mode === 'payment-beta-available') payload = { ...payload, order: betaOrder('PAYMENT_REQUIRED'), betaAuthorization: null, betaAuthorizationAvailable: true };
    // MISSION A21.04 — an open quote awaiting acceptance (no order yet).
    if (mode === 'payment-beta-quote') payload = { ...payload, order: null, executionAuthorized: false, payment: { required: false, state: null },
      quotes: [{ id: 'quote_qa', offerId: 'offer_strategy_qa', amountMinor: 29000, currency: 'EUR', expiresAt: '2026-12-01T12:00:00.000Z', createdAt: operation.lastActivityAt, accepted: false, expired: false }] };
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
        : mode === 'payment-beta-authorized' || mode === 'payment-beta-invalid'
          // A free-beta order: no payment, never payment-authorized, still frozen.
          ? { orderId: 'order_qa', orderState: 'BETA_AUTHORIZED', payment: null, refunds: [], executionAuthorized: false, ...frozen, commerce: commerce('BETA_FREE') }
        : mode === 'payment-frozen-beta' || mode === 'payment-beta-available'
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
  // QEYNOX_REGISTRATION_ENABLED is the retired web-only switch (A21.05): it is set to 'true' here to prove
  // the register page ignores it and follows the API's policy alone.
  env: { ...process.env, QEYNOX_API_URL: `http://127.0.0.1:${backend.address().port}`, NEXT_TELEMETRY_DISABLED: '1', QEYNOX_REGISTRATION_ENABLED: 'true' },
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
    console.log(`QA FIXTURE STATE: http://127.0.0.1:${backend.address().port}/__qa/state?mode=loaded&beta=active`);
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
  // MISSION A21.05 — the register page renders ONLY the API's registration policy (one authority).
  {
    const invitation = 'Ab-_' + 'x'.repeat(39);
    const hasForm = html => /id="register-email"/.test(html) && /id="register-password"/.test(html);
    const invitationInput = html => (html.match(/<input[^>]*name="invitationToken"[^>]*>/) ?? [''])[0];
    const reads = registrationPolicyReads;
    // OPEN: the form, no invitation field (uninvited signup), mode reported from the API.
    assert.match(register, /data-registration-mode="OPEN"/); assertions++;
    assert.ok(hasForm(register) && !invitationInput(register), 'OPEN renders the form without an invitation field'); assertions++;
    await page('/en/account/register');
    assert.ok(registrationPolicyReads > reads, 'every render reads the policy from the API (never cached)'); assertions++;
    assert.match(register, /<meta name="referrer" content="no-referrer"/); assertions++;
    // OPEN + invitation link: pre-filled, optional, explains beta enrollment. A malformed token is ignored.
    const openInvited = await page('/en/account/register?invitation=' + invitation);
    assert.ok(invitationInput(openInvited).includes('value="' + invitation + '"') && !/required/.test(invitationInput(openInvited)), 'OPEN pre-fills an optional invitation from the link'); assertions++;
    assert.match(openInvited, /enrolls the new workspace in the free beta/); assertions++;
    const openGarbage = await page('/en/account/register?invitation=%3Cscript%3E');
    assert.ok(!invitationInput(openGarbage) && !openGarbage.includes('<script>alert'), 'a malformed invitation token is never echoed'); assertions++;
    for (const [lang, text] of [
      ['en', { inviteTitle: 'Private beta: invitation required', inviteLabel: 'Invitation code', closed: 'Registration is closed', unavailable: 'Registration status unavailable', signIn: 'Sign in' }],
      ['fr', { inviteTitle: 'Bêta privée : invitation requise', inviteLabel: 'Code d’invitation', closed: 'Les inscriptions sont fermées', unavailable: 'État des inscriptions indisponible', signIn: 'Se connecter' }],
    ]) {
      registration = 'invite';
      const invite = await page('/' + lang + '/account/register');
      assert.match(invite, /data-registration-mode="INVITE_ONLY"/); assertions++;
      assert.ok(invite.includes(text.inviteTitle) && invite.includes(text.inviteLabel), lang + ' INVITE_ONLY explains the invitation requirement'); assertions++;
      assert.ok(hasForm(invite) && /required/.test(invitationInput(invite)), lang + ' INVITE_ONLY renders the form with a REQUIRED invitation field'); assertions++;
      assert.match(invite, /minlength="12"/i); assertions++;
      const invited = await page('/' + lang + '/account/register?invitation=' + invitation);
      assert.ok(invitationInput(invited).includes('value="' + invitation + '"'), lang + ' INVITE_ONLY pre-fills the invitation from the link'); assertions++;
      registration = 'closed';
      // The retired web switch QEYNOX_REGISTRATION_ENABLED=true is set for this server: it must not matter.
      const closed = await page('/' + lang + '/account/register');
      assert.match(closed, /data-registration-mode="CLOSED"/); assertions++;
      assert.ok(closed.includes(text.closed) && !hasForm(closed) && !invitationInput(closed), lang + ' CLOSED never offers a form'); assertions++;
      assert.ok(closed.includes(text.signIn) && closed.includes('href="/' + lang + '/account"'), lang + ' CLOSED points to sign-in'); assertions++;
      for (const failure of ['malformed', 'error']) {
        registration = failure;
        const unavailable = await page('/' + lang + '/account/register');
        assert.ok(unavailable.includes(text.unavailable) && !hasForm(unavailable), lang + ' ' + failure + ' policy fails closed (no form)'); assertions++;
        assert.match(unavailable, /data-registration-mode="UNAVAILABLE"/); assertions++;
      }
    }
    registration = 'open';
  }
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
  // A21.04: PAYMENTS_DISABLED fixtures report the matching NOT_CONFIGURED journey (no free beta).
  beta = 'not-configured';
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
  // MISSION A21.04 — in a BETA_FREE flow the payment panel is replaced by the beta offer summary: no
  // payment prompt, no card request, no checkout. Here the grant has expired, so no waiver applies.
  beta = 'expired';
  mode = 'payment-frozen-beta';
  const payBeta = await page('/en/missions/operation_qa', true);
  assert.ok(!payBeta.includes('data-commerce-mode=') && payBeta.includes('data-context="payment"') && payBeta.includes('Free beta expired'), 'BETA_FREE replaces the payment panel with the beta summary and states the expired grant'); assertions++;
  assert.ok(!payBeta.includes('payments are frozen on the server') && !payBeta.includes('Payments are currently disabled')  && !/card number|card details|Pay now|secure checkout|checkout\.stripe/i.test(payBeta), 'no payment prompt or card request in a beta flow'); assertions++;
  assert.ok(payBeta.includes('The 100% beta waiver applies only while') && !/<s>[^<]*290/.test(payBeta), 'an expired grant shows the list price without a waiver'); assertions++;
  assert.ok(!/Continue to secure checkout/.test(payBeta), 'no checkout button is offered in free beta'); assertions++;
  const payBetaFr = await page('/fr/missions/operation_qa', true);
  assert.ok(payBetaFr.includes('Bêta gratuite expirée') && payBetaFr.includes('Bêta gratuite — aucune carte requise') && !payBetaFr.includes('data-commerce-mode=') && !/Continuer vers le paiement sécurisé/.test(payBetaFr), 'the French free-beta state is translated and offers no payment panel or checkout'); assertions++;
  // MISSION A21.03 — a free-beta authorization shows the list price and 0 due, offers no payment panel
  // or checkout, and is never labelled paid.
  beta = 'active';
  mode = 'payment-beta-authorized';
  const betaAuthorized = await page('/en/missions/operation_qa', true);
  assert.ok(betaAuthorized.includes('Covered by free beta access') && betaAuthorized.includes('FREE_BETA'), 'a beta-authorized order names the free-beta basis'); assertions++;
  assert.ok(betaAuthorized.includes('List price') && /€\s?290|290(?:[.,]00)?\s?€/.test(betaAuthorized) && betaAuthorized.includes('Due now') && /€\s?0(?:[.,]00)?|0(?:[.,]00)?\s?€/.test(betaAuthorized), 'the list price stays visible and 0 is due now'); assertions++;
  assert.ok(betaAuthorized.includes('data-status="BETA_AUTHORIZED"') && betaAuthorized.includes('Free beta — authorized'), 'the order badge says free beta, not paid'); assertions++;
  assert.ok(!betaAuthorized.includes('data-commerce-mode='), 'no payment panel is rendered for a beta-authorized order'); assertions++;
  assert.ok(!/Paid<\/span>|Continue to secure checkout|checkout\.stripe/.test(betaAuthorized), 'a beta order is never shown as paid and offers no checkout'); assertions++;
  assert.ok(!betaAuthorized.includes('payments are frozen on the server'), 'no payment-required notice for a covered order'); assertions++;
  const betaAuthorizedFr = await page('/fr/missions/operation_qa', true);
  assert.ok(betaAuthorizedFr.includes('Couvert par l’accès bêta gratuit') && betaAuthorizedFr.includes('À payer maintenant') && betaAuthorizedFr.includes('Bêta gratuite — autorisée'), 'the French free-beta authorization is translated'); assertions++;
  beta = 'revoked';
  mode = 'payment-beta-invalid';
  const betaInvalid = await page('/en/missions/operation_qa', true);
  assert.ok(betaInvalid.includes('no longer applies') && betaInvalid.includes('the beta access was revoked'), 'an invalid beta authorization says why (revoked)'); assertions++;
  assert.ok(!betaInvalid.includes('Service scope accepted') && !/Continue to secure checkout/.test(betaInvalid), 'an invalid beta authorization is not shown as authorized and offers no checkout'); assertions++;
  beta = 'active';
  mode = 'payment-beta-available';
  const betaAvailable = await page('/en/missions/operation_qa', true);
  assert.ok(betaAvailable.includes('Cover with free beta access') && betaAvailable.includes('active beta access'), 'an eligible PAYMENT_REQUIRED order offers the free-beta conversion'); assertions++;
  assert.ok(!betaAvailable.includes('payments are frozen on the server') && !/Continue to secure checkout/.test(betaAvailable), 'the conversion replaces the frozen-payment notice and offers no checkout'); assertions++;
  assert.ok(!betaAvailable.includes('data-commerce-mode=') && betaAvailable.includes('data-context="payment"') && betaAvailable.includes('Beta waiver (100%)') && /<s>[^<]*290/.test(betaAvailable), 'an eligible order shows the waived list price instead of a payment panel'); assertions++;
  beta = 'not-configured';
  mode = 'payment-legacy-unfrozen';
  const payLegacy = await page('/en/missions/operation_qa', true);
  assert.ok(payLegacy.includes('Payment status unavailable'), 'a response without the commerce block is rejected, not rendered'); assertions++;
  assert.ok(!/Continue to secure checkout|Try again<\/button>/.test(payLegacy) && !payLegacy.includes('checkout.stripe'), 'a legacy payable response never yields a checkout action'); assertions++;
  // ── MISSION A21.04 — free-beta customer journey (EN/FR, every state, every surface) ──────────────
  const flat = html => html.replaceAll('<!-- -->', '');
  const zeroEuro = /€\s?0(?:[.,]00)?(?!\d)|0(?:[.,]00)?\s?€/;
  const stateTitles = {
    'not-enrolled': ['NOT_ENROLLED', 'Not enrolled in the free beta', 'Non inscrit à la bêta gratuite'],
    expired: ['EXPIRED', 'Free beta expired', 'Bêta gratuite expirée'],
    revoked: ['REVOKED', 'Free beta access revoked', 'Accès bêta gratuit révoqué'],
    quota: ['QUOTA_EXHAUSTED', 'Beta mission allowance used up', 'Quota de missions bêta épuisé'],
    runtime: ['RUNTIME_UNAVAILABLE', 'Mission runtime unavailable', 'Moteur d’exécution indisponible'],
    'not-configured': ['NOT_CONFIGURED', 'Free beta not configured', 'Bêta gratuite non configurée'],
    invited: ['INVITATION_PENDING', 'Invitation awaiting activation', 'Invitation en attente d’activation'],
  };
  mode = 'loaded';
  beta = 'active';
  const dashActive = flat(await page('/en/mydash', true));
  assert.ok(dashActive.includes('Your free beta access') && dashActive.includes('Free beta — no card required'), 'MyDash shows the free-beta card and its headline'); assertions++;
  assert.ok(dashActive.includes('Amount due today') && zeroEuro.test(dashActive), 'MyDash states 0 due today'); assertions++;
  assert.ok(dashActive.includes('Beta missions remaining') && dashActive.includes('3 of 5'), 'MyDash shows the remaining beta allowance'); assertions++;
  assert.ok(dashActive.includes('Beta access expires') && dashActive.includes('December 31, 2026'), 'MyDash shows the beta expiry (locale date)'); assertions++;
  assert.ok(dashActive.includes('data-beta-account="ACTIVE"') && dashActive.includes('data-beta-state="ACTIVE"') && dashActive.includes('Free beta active'), 'MyDash shows the account status and the active state in text'); assertions++;
  assert.ok(!/checkout|credit card|Pay now/i.test(dashActive), 'MyDash offers no checkout or card prompt'); assertions++;
  assert.ok(dashActive.includes('qx-beta-inline'), 'mission creation states the free-beta terms'); assertions++;
  const dashActiveFr = flat(await page('/fr/mydash', true));
  assert.ok(dashActiveFr.includes('Bêta gratuite — aucune carte requise') && dashActiveFr.includes('Montant dû aujourd’hui') && dashActiveFr.includes('3 sur 5') && dashActiveFr.includes('31 décembre 2026') && dashActiveFr.includes('Actif'), 'French MyDash: headline, 0 due, allowance, expiry, status'); assertions++;
  for (const [kind, [state, en, fr]] of Object.entries(stateTitles)) {
    beta = kind;
    const dash = flat(await page('/en/mydash', true));
    assert.ok(dash.includes('data-beta-state="' + state + '"') && dash.includes(en), 'MyDash renders ' + state + ' (EN)'); assertions++;
    assert.ok(!dash.includes('Free beta active'), state + ' is never shown as active'); assertions++;
    const dashFr = flat(await page('/fr/mydash', true));
    assert.ok(dashFr.includes('data-beta-state="' + state + '"') && dashFr.includes(fr), 'MyDash renders ' + state + ' (FR)'); assertions++;
  }
  beta = 'quota';
  assert.ok(flat(await page('/en/mydash', true)).includes('0 of 5'), 'an exhausted allowance shows 0 remaining'); assertions++;
  beta = 'not-configured';
  const dashDisabled = flat(await page('/en/mydash', true));
  assert.ok(dashDisabled.includes('Payments disabled — no card required') && !dashDisabled.includes('Free beta — no card required'), 'NOT_CONFIGURED never claims a free beta'); assertions++;
  beta = 'invited';
  const dashInvited = flat(await page('/en/mydash', true));
  assert.ok(dashInvited.includes('name="token"') && dashInvited.includes('Activate beta access') && dashInvited.includes('Invitation expires'), 'a pending invitation offers activation to an owner/admin with its expiry'); assertions++;
  beta = 'unavailable';
  const dashUnavailable = flat(await page('/en/mydash', true));
  assert.ok(dashUnavailable.includes('Beta status unavailable (NOT_CONFIGURED)') && !dashUnavailable.includes('Free beta — no card required') && !dashUnavailable.includes('Free beta active'), 'an unreadable journey claims nothing'); assertions++;
  beta = 'malformed';
  const dashMalformed = flat(await page('/en/mydash', true));
  assert.ok(dashMalformed.includes('Beta status unavailable (INVALID_RESPONSE)') && !dashMalformed.includes('Free beta active'), 'a journey asking for a card is rejected, not rendered'); assertions++;
  // Catalogue and service detail.
  beta = 'active';
  const catalogue = flat(await page('/en/services', true));
  assert.ok(/<s>[^<]*290[^<]*<\/s>/.test(catalogue) && catalogue.includes('List price, waived by the free beta:'), 'the catalogue crosses out the waived list price with a screen-reader label'); assertions++;
  assert.ok(catalogue.includes('Free beta · nothing due today') && catalogue.includes('data-beta-state="ACTIVE"'), 'the catalogue states the free-beta terms and state'); assertions++;
  assert.ok(catalogue.includes('Free — explicitly authorized by the operator') && !/<s>[^<]*€0/.test(catalogue), 'a free offer is not shown as waived'); assertions++;
  const catalogueFr = flat(await page('/fr/services', true));
  assert.ok(catalogueFr.includes('Bêta gratuite · rien à payer aujourd’hui') && /<s>[^<]*290[^<]*<\/s>/.test(catalogueFr), 'French catalogue'); assertions++;
  beta = 'expired';
  const catalogueExpired = flat(await page('/en/services', true));
  assert.ok(!/<s>[^<]*290/.test(catalogueExpired) && catalogueExpired.includes('Free beta expired'), 'an expired grant shows the list price, uncrossed, and the expired state'); assertions++;
  beta = 'active';
  const detail = flat(await page('/en/services/offer_strategy_qa', true));
  assert.ok(detail.includes('data-context="service"') && detail.includes('Free beta — no card required') && detail.includes('Beta waiver (100%)') && /−€290|−290/.test(detail), 'service detail: headline and the labelled 100% waiver'); assertions++;
  assert.ok(detail.includes('Amount due today') && zeroEuro.test(detail) && detail.includes('3 of 5') && detail.includes('Account status'), 'service detail: 0 due, allowance and account status'); assertions++;
  const detailFr = flat(await page('/fr/services/offer_strategy_qa', true));
  assert.ok(detailFr.includes('Remise bêta (100 %)') && detailFr.includes('Prix catalogue') && detailFr.includes('Montant dû aujourd’hui'), 'French service detail'); assertions++;
  beta = 'not-configured';
  const detailDisabled = flat(await page('/en/services/offer_strategy_qa', true));
  assert.ok(!detailDisabled.includes('Beta waiver (100%)') && detailDisabled.includes('Free beta not configured') && detailDisabled.includes('Payments disabled — no card required'), 'NOT_CONFIGURED claims no waiver on the service detail'); assertions++;
  // Quote acceptance and launch on the mission page.
  beta = 'active';
  mode = 'payment-beta-quote';
  const quotePage = flat(await page('/en/missions/operation_qa', true));
  assert.ok(quotePage.includes('data-context="quote"') && quotePage.includes('Beta waiver (100%)') && quotePage.includes('Accepting records the quote at its list price'), 'quote acceptance shows the waiver before accepting'); assertions++;
  assert.ok(quotePage.includes('data-context="launch"') && quotePage.includes('Launching uses one mission of your beta allowance'), 'the launch card states the beta terms'); assertions++;
  assert.ok(!quotePage.includes('data-commerce-mode=') && !/Continue to secure checkout|checkout\.stripe/.test(quotePage), 'no payment panel or checkout before acceptance'); assertions++;
  const quotePageFr = flat(await page('/fr/missions/operation_qa', true));
  assert.ok(quotePageFr.includes('Remise bêta (100 %)') && quotePageFr.includes('L’acceptation enregistre le devis'), 'French quote acceptance'); assertions++;
  beta = 'runtime';
  const launchRuntime = flat(await page('/en/missions/operation_qa', true));
  assert.ok(launchRuntime.includes('Mission runtime unavailable') && !launchRuntime.includes('Launching uses one mission of your beta allowance'), 'the launch card states RUNTIME_UNAVAILABLE instead of the launch note'); assertions++;
  beta = 'active';
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
