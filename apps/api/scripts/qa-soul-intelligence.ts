import 'reflect-metadata';
import pg from 'pg';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { createIsolatedQaDatabase } from './qa-isolated-database';
import { QeyNoxStore, connectDatabase, runMigrations } from '@qeynox/persistence';
import {
  GuidedOnboardingService, AgentProfileStore,
  buildGuidanceMessage, fallbackQuestion, looksLikeRefusal, placeholderIdentity,
  MAX_GUIDED_TURNS,
  type GuidedTurn,
} from '@qeynox/roles';
import type { AgentProfile, EnginePort, EngineRequest, EngineOutcome } from '@qeynox/engine';
import { DomainError, type Principal } from '@qeynox/domain';
import { agentProfiles } from '@qeynox/persistence';

/**
 * MISSION A05 — intelligent Soul onboarding gate.
 *
 * Two layers, because they fail differently:
 *  - the HTTP layer proves the state machine, consent, isolation and mission flow are unchanged;
 *  - the service layer drives the optional guidance with scripted engines, because a refusal, an
 *    offline engine and a timeout cannot be produced through the real adapter without a provider.
 *
 * No assertion depends on a real model. Every "AI" assertion runs against a fake engine that echoes a
 * fixed string, so a passing run never implies a provider was reachable.
 */

const PASS_LINES: string[] = [];
function pass(line: string): void { PASS_LINES.push(line); console.log('PASS: ' + line); }

const PROFILE: AgentProfile = {
  id: 'profile-soul-qa' as AgentProfile['id'], role: 'soul', version: 1, title: 'QA Soul',
  systemInstructions: 'QA soul instructions', skillRefs: [], allowedTools: [],
  permittedContextKeys: [], maxOutputTokens: 512, maxIterations: 1,
};

/** Records what the service asked for, so we can assert on bounds and payload shape. */
interface Recorder { requests: EngineRequest[] }
function engineReturning(rec: Recorder, outcome: Partial<EngineOutcome> | (() => Promise<EngineOutcome>)): EnginePort {
  return {
    isAvailable: () => ({ available: true, reason: 'READY' }),
    async invoke(request: EngineRequest): Promise<EngineOutcome> {
      rec.requests.push(request);
      if (typeof outcome === 'function') return outcome();
      return {
        status: 'COMPLETED', engine: 'qa-fake', content: 'Let us sharpen that objective.', proposedTools: [],
        receivedAt: new Date().toISOString(), ...outcome,
      };
    },
  };
}

const qa = await createIsolatedQaDatabase();
process.env.DATABASE_URL = qa.url;
process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
const started = Date.now();

try {
  await runMigrations(qa.url);
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + (app.getHttpServer().address() as { port: number }).port;

  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const register = async (email: string) => {
    const user = await call('/v1/auth/register', { email, password: 'qa-soul-passphrase', workspaceName: 'QA soul' });
    assert.equal(user.status, 201);
    return {
      authorization: 'Bearer ' + user.body.token,
      'x-qeynox-workspace': user.body.workspaceId,
      userId: user.body.userId as string,
      workspaceId: user.body.workspaceId as string,
    };
  };
  const advanceToConsent = async (h: Record<string, string>) => {
    assert.equal((await call('/v1/soul/onboarding/start', { locale: 'en' }, h)).status, 201);
    await call('/v1/soul/onboarding/answer', { step: 'WELCOME', value: 'begin' }, h);
    await call('/v1/soul/onboarding/answer', { step: 'LANGUAGE', value: 'en' }, h);
  };

  const alice = await register('a05-alice@example.invalid');
  const bob = await register('a05-bob@example.invalid');
  const h = { authorization: alice.authorization, 'x-qeynox-workspace': alice.workspaceId };

  // ── 1. The view reports engine readiness truthfully instead of a hardcoded literal ──────────────
  // No Hermes credentials are configured in QA, so the adapter must report NOT ready, and the view
  // must say so. Before A05 this field was the literal 'PRE_MISSION_CONTRACT'.
  await call('/v1/soul/onboarding/start', { locale: 'en' }, h);
  const notStartedView = await call('/v1/soul/onboarding', undefined, h);
  assert.equal(notStartedView.status, 200);
  assert.equal(notStartedView.body.aiAvailable, false, 'unconfigured engine must never report AI as available');
  assert.notEqual(notStartedView.body.aiReason, 'PRE_MISSION_CONTRACT');
  assert.equal(notStartedView.body.guidanceAvailable, notStartedView.body.aiAvailable);
  assert.equal('deterministic' in notStartedView.body, false, 'the untruthful deterministic flag is gone');
  pass('onboarding view reports real engine readiness (aiAvailable=false, reason=' + notStartedView.body.aiReason + ')');

  // ── 2. Guided help is refused on steps that are not free text, and never advances state ─────────
  const attempt = (suffix: string) => ({ attemptKey: 'qa-attempt-' + suffix });
  await call('/v1/soul/onboarding/answer', { step: 'WELCOME', value: 'begin' }, h);
  // Now on LANGUAGE, which is a choice, not a question to converse about.
  assert.equal((await call('/v1/soul/onboarding', undefined, h)).body.step, 'LANGUAGE');
  const guidedOnLanguage = await call('/v1/soul/onboarding/guide', attempt('lang'), h);
  assert.equal(guidedOnLanguage.status, 409, 'INVALID_STATE maps to 409');
  assert.equal(guidedOnLanguage.body.error.code, 'INVALID_STATE');
  assert.equal((await call('/v1/soul/onboarding', undefined, h)).body.step, 'LANGUAGE', 'a refused guide call must not move the step');
  pass('guided input is refused on non-conversational steps and leaves the step unchanged');

  // ── 3. Guidance before consent: no facts are read, and nothing is written ───────────────────────
  await call('/v1/soul/onboarding/answer', { step: 'LANGUAGE', value: 'en' }, h);
  assert.equal((await call('/v1/soul/onboarding', undefined, h)).body.step, 'CONSENT');
  assert.equal((await call('/v1/soul/onboarding/guide', attempt('consent'), h)).status, 409);
  pass('guided input cannot be used to talk past the consent step');

  // Decline consent: every content step is skipped, guidance stays unavailable, mission still works.
  const declined = await call('/v1/soul/onboarding/consent', { granted: false }, h);
  assert.equal(declined.body.step, 'FIRST_OBJECTIVE');
  assert.equal(declined.body.consent.granted, false);
  const guidedAfterDecline = await call('/v1/soul/onboarding/guide', attempt('declined'), { ...h });
  // FIRST_OBJECTIVE accepts guidance, but with no consent there is no grounding to send. The call
  // must still be safe; what matters is that it cannot write a fact.
  assert.equal((await call('/v1/soul/context', undefined, h)).body.length, 0);
  assert.ok([201, 409].includes(guidedAfterDecline.status), 'guide must answer or refuse cleanly, never 500');
  assert.equal((await call('/v1/soul/context', undefined, h)).body.length, 0, 'guidance must never write a fact');
  assert.equal((await call('/v1/soul/onboarding', undefined, h)).body.step, 'FIRST_OBJECTIVE');
  assert.equal(guidedAfterDecline.status, 201, 'no active Soul profile must degrade to the fallback, not fail the page');
  assert.equal(guidedAfterDecline.body.reason, 'ENGINE_NOT_CONFIGURED');
  assert.equal(guidedAfterDecline.body.aiGenerated, false);
  pass('guidance after declined consent writes no fact, leaves the step unchanged and degrades without a profile');

  // ── 4. Offline inference: the real adapter is unconfigured, so guidance must fall back ──────────
  const offline = await call('/v1/soul/onboarding/guide', { ...attempt('offline'), message: 'Help me phrase this' }, h);
  assert.equal(offline.status, 201);
  assert.equal(offline.body.source, 'DETERMINISTIC_FALLBACK');
  assert.equal(offline.body.aiGenerated, false);
  assert.equal(offline.body.reason, 'ENGINE_NOT_CONFIGURED');
  assert.equal(offline.body.stepUnchanged, true);
  assert.ok(offline.body.content.length > 10);
  assert.equal((await call('/v1/operations', undefined, h)).body.length, 0, 'guidance must never create an operation');
  pass('offline engine falls back deterministically and creates no operation');

  // ── 5. Mission creation is untouched by having used guidance ───────────────────────────────────
  const mission = await call('/v1/soul/onboarding/mission', { objective: 'Find three wholesale suppliers in Morocco' }, h);
  assert.equal(mission.status, 201);
  assert.equal((await call('/v1/soul/onboarding', undefined, h)).body.status, 'COMPLETED');
  const retried = await call('/v1/soul/onboarding/mission', { objective: 'Find three wholesale suppliers in Morocco' }, h);
  assert.equal(retried.body.id, mission.body.id, 'mission creation stays idempotent');
  const conflicting = await call('/v1/soul/onboarding/mission', { objective: 'A completely different objective' }, h);
  assert.equal(conflicting.body.error.code, 'CONFLICT');
  assert.equal((await call('/v1/operations', undefined, h)).body.length, 1);
  pass('idempotent first-mission flow, objective conflict detection and single operation preserved');

  // Guidance is closed once onboarding is complete.
  assert.equal((await call('/v1/soul/onboarding/guide', attempt('done'), h)).status, 409);
  pass('guidance is unavailable after onboarding completes');

  // ── 6. Service-level guidance with scripted engines ────────────────────────────────────────────
  const pool = new pg.Pool({ connectionString: qa.url });
  const connection = connectDatabase(qa.url);
  const principal = (workspaceId: string, userId: string): Principal => ({
    workspaceId: workspaceId as Principal['workspaceId'], userId: userId as Principal['userId'], roles: ['OWNER'],
  });

  try {
    const store = new QeyNoxStore(connection.db);
    // Publish a real ACTIVE soul profile so the guided path runs exactly as it would in an
    // operator-configured deployment, and assert the store can actually read it back.
    await store.db.insert(agentProfiles).values({
      id: PROFILE.id, roleKey: 'soul', version: PROFILE.version, active: true,
      payload: PROFILE as unknown as Record<string, unknown>,
    });
    assert.deepEqual(await new AgentProfileStore(store.db).getActive('soul'), PROFILE);

    const guided = (engine: EnginePort, now?: () => Date) =>
      new GuidedOnboardingService(engine, async () => PROFILE, now ? { now } : {});
    const onboardingId = 'qa-onboarding-' + alice.userId;
    const actor = principal(alice.workspaceId, alice.userId);

    // 6a. AI path: exactly one call per attempt key, and the payload carries no consented facts.
    const rec: Recorder = { requests: [] };
    const ai = guided(engineReturning(rec, {}));
    const first = await ai.guide(actor, {
      onboardingId, step: 'OBJECTIVES', message: 'We sell argan oil', attemptKey: 'qa-ai-attempt-1', locale: 'en',
      answers: [{ step: 'ACTIVITY', value: 'Argan oil wholesale' }],
    });
    assert.equal(first.source, 'AI');
    assert.equal(first.aiGenerated, true);
    assert.equal(first.reason, 'OK');
    assert.equal(rec.requests.length, 1);
    assert.deepEqual(rec.requests[0]!.context, {}, 'guidance must not send consented context facts to the model');
    const sent = rec.requests[0]!;
    assert.match(sent.operationId, /^onboarding-op-/, 'placeholder ids must be namespace-distinguishable');
    assert.match(sent.stepAttemptId, /^onboarding-attempt-/);
    assert.notEqual(sent.operationId, sent.stepAttemptId);
    assert.match(sent.userMessage, /Argan oil wholesale/, 'answers already given must be used to avoid re-asking');
    assert.equal(sent.profile.role, 'soul');
    pass('AI guidance is labelled AI, sends no facts, and uses namespaced placeholder ids');

    // 6b. Retry of the same attempt key is free and returns the identical result.
    const replay = await ai.guide(actor, { onboardingId, step: 'OBJECTIVES', message: 'We sell argan oil', attemptKey: 'qa-ai-attempt-1', locale: 'en' });
    assert.deepEqual(replay, first);
    assert.equal(rec.requests.length, 1, 'a retried attempt must not call the model twice');
    pass('a retried guidance attempt reuses the first result without a second model call');

    // 6c. Placeholder ids are stable per onboarding+step and differ per step.
    assert.deepEqual(placeholderIdentity(onboardingId, 'OBJECTIVES'), placeholderIdentity(onboardingId, 'OBJECTIVES'));
    assert.notDeepEqual(placeholderIdentity(onboardingId, 'OBJECTIVES'), placeholderIdentity(onboardingId, 'NEEDS'));
    pass('placeholder identity is deterministic per onboarding and step, and varies by step');

    // 6d. A refusal is not guidance.
    const refused = await guided(engineReturning({ requests: [] }, {
      content: "I'm sorry, but I can't help with that request.", status: 'COMPLETED',
    })).guide(actor, { onboardingId, step: 'NEEDS', attemptKey: 'qa-refuse-attempt-1', locale: 'en' });
    assert.equal(refused.source, 'DETERMINISTIC_FALLBACK');
    assert.equal(refused.reason, 'ENGINE_REFUSED');
    assert.equal(refused.aiGenerated, false);
    assert.equal(refused.content, fallbackQuestion('en', 'NEEDS'));
    pass('a model refusal is reported as ENGINE_REFUSED and replaced by fallback text');

    // 6e. A genuinely businessy reply containing "cannot" is NOT mistaken for a refusal.
    assert.equal(looksLikeRefusal('You cannot sell to that segment without a licence, so let us narrow the objective.'), false);
    assert.equal(looksLikeRefusal('I cannot help with that.'), true);
    pass('refusal detection is conservative and does not reject ordinary business prose');

    // 6f. Offline: the engine throws NOT_CONFIGURED.
    const offlineService = await guided({
      isAvailable: () => ({ available: false, reason: 'NO_CREDENTIAL' }),
      async invoke(): Promise<EngineOutcome> { throw new DomainError('NOT_CONFIGURED', 'no key'); },
    }).guide(actor, { onboardingId, step: 'PREFERENCES', attemptKey: 'qa-offline-attempt-1', locale: 'fr' });
    assert.equal(offlineService.reason, 'ENGINE_NOT_CONFIGURED');
    assert.equal(offlineService.aiGenerated, false);
    assert.equal(offlineService.content, fallbackQuestion('fr', 'PREFERENCES'), 'fallback must honour the onboarding locale');
    pass('an offline engine yields a deterministic fallback in the customer language');

    // 6g. Timeout: an engine that never resolves is bounded by the outer timeout.
    const hanging: EnginePort = {
      isAvailable: () => ({ available: true, reason: 'READY' }),
      invoke: (_request: EngineRequest, options?: { signal?: AbortSignal }) => new Promise<EngineOutcome>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }),
    };
    const timed = Date.now();
    const timeoutResult = await new GuidedOnboardingService(hanging, async () => PROFILE, { timeoutMs: 120 })
      .guide(actor, { onboardingId, step: 'ACTIVITY', attemptKey: 'qa-timeout-attempt-1', locale: 'en' });
    assert.equal(timeoutResult.reason, 'ENGINE_TIMEOUT');
    assert.equal(timeoutResult.aiGenerated, false);
    assert.ok(Date.now() - timed < 3000, 'the outer timeout must bound the wait');
    pass('a hanging engine is bounded by the timeout and reported as ENGINE_TIMEOUT');

    // 6h. Empty completion and failed status are never presented as AI text.
    const empty = await guided(engineReturning({ requests: [] }, { content: '   ' }))
      .guide(actor, { onboardingId, step: 'OBJECTIVES', attemptKey: 'qa-empty-attempt-1', locale: 'en' });
    assert.equal(empty.reason, 'ENGINE_EMPTY');
    assert.equal(empty.aiGenerated, false);
    const failed = await guided(engineReturning({ requests: [] }, { status: 'FAILED', content: 'partial' }))
      .guide(actor, { onboardingId, step: 'OBJECTIVES', attemptKey: 'qa-failed-attempt-1', locale: 'en' });
    assert.equal(failed.reason, 'ENGINE_UNAVAILABLE');
    assert.equal(failed.aiGenerated, false);
    pass('empty and failed completions fall back instead of being shown as AI guidance');

    // 6i. Turn ceiling: beyond MAX_GUIDED_TURNS the model is not called at all.
    const turnRecorder: Recorder = { requests: [] };
    const history: GuidedTurn[] = Array.from({ length: MAX_GUIDED_TURNS + 1 }, (_value, index) => ({
      role: 'CUSTOMER', content: 'turn ' + index, at: new Date().toISOString(),
    }));
    const limited = await guided(engineReturning(turnRecorder, {})).guide(actor, {
      onboardingId, step: 'NEEDS', attemptKey: 'qa-limit-attempt-1', locale: 'en', history,
    });
    assert.equal(limited.reason, 'TURN_LIMIT');
    assert.equal(turnRecorder.requests.length, 0, 'the turn ceiling must prevent the model call entirely');
    pass('the turn ceiling stops the conversation at ' + MAX_GUIDED_TURNS + ' customer turns without calling the model');

    // 6j. No profile published -> NOT_CONFIGURED -> deterministic fallback, not a 500.
    const withoutProfile = await new GuidedOnboardingService(engineReturning({ requests: [] }, {}), async () => {
      throw new DomainError('NOT_CONFIGURED', 'No active agent profile for soul');
    }).guide(actor, { onboardingId, step: 'OBJECTIVES', attemptKey: 'qa-noprofile-attempt-1', locale: 'en' });
    assert.equal(withoutProfile.reason, 'ENGINE_NOT_CONFIGURED');
    assert.equal(withoutProfile.aiGenerated, false);
    pass('a missing Soul profile degrades to the fallback instead of failing the onboarding page');

    // 6k. Prompt construction: bounded, locale-aware, and never leaks a context key.
    const built = buildGuidanceMessage({
      locale: 'fr', step: 'OBJECTIVES', message: 'bonjour', answers: [],
      history: Array.from({ length: 20 }, (_v, index) => ({ role: 'CUSTOMER' as const, content: 'h' + index, at: 'x' })),
    });
    assert.match(built, /French/, 'the prompt must demand the onboarding language');
    assert.equal((built.match(/\bh\d+\b/g) ?? []).length, 8, 'only the most recent turns are sent');
    assert.match(built, /Do not invent facts/);
    assert.doesNotMatch(built, /revenue target|consentId/i);
    pass('guidance prompt is locale-aware, bounded to recent turns and carries no customer facts');

    // 6l. Multi-workspace and multi-user: the same attempt key in another scope is a distinct call.
    const other = principal('qa-workspace-other', alice.userId);
    const scopeRecorder: Recorder = { requests: [] };
    const scoped = guided(engineReturning(scopeRecorder, {}));
    await scoped.guide(actor, { onboardingId, step: 'OBJECTIVES', message: 'Marrakech', attemptKey: 'qa-shared-attempt-1', locale: 'en' });
    await scoped.guide(other, { onboardingId, step: 'OBJECTIVES', message: 'Rabat', attemptKey: 'qa-shared-attempt-1', locale: 'en' });
    assert.equal(scopeRecorder.requests.length, 2, 'an attempt key must not replay across workspaces');
    assert.notDeepEqual(scopeRecorder.requests[0]!.correlationId, scopeRecorder.requests[1]!.correlationId);
    pass('an attempt key is scoped per workspace and user, so it cannot leak a result across tenants');

    // ── 7. Guidance through the service with consent: grounding respects revocation ──────────────
    const carol = await register('a05-carol@example.invalid');
    const ch = { authorization: carol.authorization, 'x-qeynox-workspace': carol.workspaceId };
    await advanceToConsent(ch);
    const granted = await call('/v1/soul/onboarding/consent', { granted: true }, ch);
    assert.equal(granted.body.consent.granted, true);
    await call('/v1/soul/onboarding/answer', { step: 'ACTIVITY', value: 'Specialty coffee roasting' }, ch);
    assert.equal((await call('/v1/soul/context', undefined, ch)).body.length, 1);
    const withConsent = await call('/v1/soul/onboarding/guide', { ...attempt('consented'), message: 'Who should we target?' }, ch);
    assert.equal(withConsent.status, 201);
    assert.equal(withConsent.body.step, 'OBJECTIVES');
    assert.equal(withConsent.body.stepUnchanged, true);
    // Revocation hides the fact from the read path without deleting it, so grounding disappears.
    assert.equal((await call('/v1/soul/consents/' + granted.body.consent.consentId + '/revoke', {}, ch)).status, 201);
    assert.equal((await call('/v1/soul/context', undefined, ch)).body.length, 0);
    const revokedGuidance = await call('/v1/soul/onboarding/guide', { ...attempt('revoked'), message: 'And now?' }, ch);
    assert.equal(revokedGuidance.status, 201);
    assert.equal(revokedGuidance.body.source, 'DETERMINISTIC_FALLBACK');
    const stored = await pool.query(
      "SELECT count(*)::int AS n FROM user_contexts WHERE workspace_id=$1 AND payload->>'deletedAt' IS NULL",
      [carol.workspaceId],
    );
    assert.equal(stored.rows[0].n, 1, 'revoking consent must hide the fact, not destroy the row');
    pass('after consent revocation guidance loses its grounding, the fact row survives and guidance stays deterministic');

    // The revoked user can still finish onboarding and create the mission.
    for (const step of ['OBJECTIVES', 'NEEDS', 'PREFERENCES']) {
      assert.equal((await call('/v1/soul/onboarding/skip', { step }, ch)).status, 201);
    }
    assert.equal((await call('/v1/soul/onboarding/mission', { objective: 'Open two wholesale accounts in Tangier' }, ch)).status, 201);
    assert.equal((await call('/v1/soul/context', undefined, ch)).body.length, 0);
    pass('revoked consent still allows skipping the remainder and creating the first mission');

    // ── 8. Cross-tenant isolation of the onboarding record itself ─────────────────────────────────
    const bh = { authorization: bob.authorization, 'x-qeynox-workspace': bob.workspaceId };
    assert.equal((await call('/v1/soul/onboarding', undefined, bh)).body.status, 'NOT_STARTED');
    assert.equal((await call('/v1/soul/onboarding/guide', attempt('bob'), bh)).status, 404);
    assert.equal((await call('/v1/soul/onboarding/guide', attempt('revoked'), bh)).status, 404, 'an attempt key from another tenant must not resolve');
    pass('another user has no onboarding record and cannot obtain guidance from it');
  } finally {
    // Close every pool we opened before the database is dropped, so teardown does not race a
    // still-idle client and print a spurious connection error.
    await pool.end();
    await connection.close();
  }

  console.log('\nIntelligent Soul onboarding (A05) — ' + PASS_LINES.length + ' groups PASS in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
} finally {
  if (app) await app.close();
  await qa.drop();
}
