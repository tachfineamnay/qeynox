import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  DomainError, assertConsent, isConsentActive, contextSubset, newId,
  SOUL_FIRST_OBJECTIVE_FACT_KEY, SOUL_ONBOARDING_CONTENT_STEPS, SOUL_ONBOARDING_FACT_KEYS,
  SOUL_ONBOARDING_STEPS, soulOnboardingStepOrder,
  type Consent, type ID, type Principal, type SoulOnboardingContentStep, type SoulOnboardingDisplayStatus,
  type SoulOnboardingRecord, type SoulOnboardingStep, type UserContext,
} from '@qeynox/domain';
import { QeyNoxStore, consents, soulOnboarding, commandIds, type QeyNoxDatabase } from '@qeynox/persistence';
import type { AgentProfile, EnginePort, EngineOutcome } from '@qeynox/engine';
import { AgentProfileStore } from './profiles';
import {
  GuidedOnboardingService, isGuidedStep,
  type GuidedOnboardingPort, type GuidedTurn,
} from './soul-guidance';

export class SoulService {
  constructor(private readonly store:QeyNoxStore,private readonly profiles:AgentProfileStore,private readonly engine:EnginePort) {}

  /** Read-only access to the configured engine, so readiness can be reported truthfully. */
  get enginePort(): EnginePort { return this.engine; }

  /**
   * The active, versioned Soul profile. Throws NOT_CONFIGURED when the operator has not published
   * one, which is exactly the condition under which guidance must fall back deterministically.
   */
  activeSoulProfile(): Promise<AgentProfile> { return this.profiles.getActive('soul'); }

  withStore(store: QeyNoxStore): SoulService { return new SoulService(store, this.profiles, this.engine); }

  async grantConsent(actor:Principal,purpose:string,scopes:readonly string[],expiresAt?:string):Promise<Consent> {
    if(!scopes.length||!purpose.trim())throw new DomainError('INVALID_INPUT','Consent must name purpose and scopes');
    const now=new Date().toISOString();
    if(!isConsentActive({expiresAt},now))throw new DomainError('INVALID_INPUT','Consent expiration must be a valid future timestamp with timezone');
    const consent:Consent={id:newId(),userId:actor.userId,workspaceId:actor.workspaceId,purpose,scopes,grantedAt:now,expiresAt:expiresAt===undefined?undefined:new Date(expiresAt).toISOString(),version:1};
    await this.store.putConsent(consent);
    return consent;
  }
  async revokeConsent(actor:Principal,consentId:ID):Promise<void> {
    const [value]=await this.store.db.select().from(consents).where(and(eq(consents.id,consentId),eq(consents.workspaceId,actor.workspaceId),eq(consents.userId,actor.userId))).limit(1);
    if(!value)throw new DomainError('NOT_FOUND','Consent does not exist');
    if(value.payload.revokedAt)return;
    await this.store.db.update(consents).set({payload:{...value.payload,revokedAt:new Date().toISOString(),version:value.payload.version+1}}).where(eq(consents.id,consentId));
  }
  async saveFact(actor:Principal,key:string,value:unknown,consentId:ID):Promise<UserContext> {
    const consents=await this.store.getConsents(actor.workspaceId,actor.userId);
    const permit=consents.find(c=>c.id===consentId);
    assertConsent(permit,'context:write',actor.userId,actor.workspaceId,new Date().toISOString());
    if(!key.trim() || key.length>80)throw new DomainError('INVALID_INPUT','Context key invalid');
    const old=(await this.store.getContext(actor.workspaceId,actor.userId)).find(x=>x.key===key&&!x.deletedAt);
    const now=new Date().toISOString();
    const fact:UserContext={id:old?.id??newId(),workspaceId:actor.workspaceId,ownerUserId:actor.userId,key,value,consentId,origin:'USER',createdAt:old?.createdAt??now,updatedAt:now};
    await this.store.saveContext(fact);return fact;
  }
  async viewContext(actor:Principal):Promise<readonly UserContext[]> {
    const items=await this.store.getContext(actor.workspaceId,actor.userId);
    const permits=await this.store.getConsents(actor.workspaceId,actor.userId);
    return contextSubset(items,permits,['context:read'],new Date().toISOString());
  }
  async deleteFact(actor:Principal,factId:ID):Promise<void> {
    const value=(await this.store.getContext(actor.workspaceId,actor.userId)).find(x=>x.id===factId);
    if(!value)throw new DomainError('NOT_FOUND','Context fact missing');
    await this.store.saveContext({...value,value:null,deletedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  }
  async listConsents(actor:Principal):Promise<readonly Consent[]> {
    return this.store.getConsents(actor.workspaceId,actor.userId);
  }
  async deleteAllContext(actor:Principal):Promise<{ readonly deleted:number }> {
    const facts=await this.viewContext(actor);
    let deleted=0;
    for(const fact of facts){ if(fact.deletedAt) continue; await this.deleteFact(actor,fact.id); deleted+=1; }
    return { deleted };
  }
  async converse(actor:Principal,message:string,operationId:ID,attemptId:ID):Promise<EngineOutcome> {
    const profile=await this.profiles.getActive('soul');
    if(message.length>5000)throw new DomainError('INVALID_INPUT','Message too long');
    const facts=await this.viewContext(actor);
    const selective=Object.fromEntries(facts.filter(f=>profile.permittedContextKeys.includes(f.key)).map(f=>[f.key,f.value]));
    return this.engine.invoke({workspaceId:actor.workspaceId,operationId,stepAttemptId:attemptId,profile,userMessage:message,context:selective,correlationId:newId()});
  }
}


const onboardingNext: Readonly<Record<SoulOnboardingStep, SoulOnboardingStep>> = {
  WELCOME: 'LANGUAGE', LANGUAGE: 'CONSENT', CONSENT: 'ACTIVITY', ACTIVITY: 'OBJECTIVES',
  OBJECTIVES: 'NEEDS', NEEDS: 'PREFERENCES', PREFERENCES: 'FIRST_OBJECTIVE', FIRST_OBJECTIVE: 'DONE', DONE: 'DONE',
};
const onboardingQuestionKeys: Readonly<Record<SoulOnboardingStep, string>> = {
  WELCOME: 'onboarding.welcome', LANGUAGE: 'onboarding.language', CONSENT: 'onboarding.consent',
  ACTIVITY: 'onboarding.activity', OBJECTIVES: 'onboarding.objectives', NEEDS: 'onboarding.needs',
  PREFERENCES: 'onboarding.preferences', FIRST_OBJECTIVE: 'onboarding.firstObjective', DONE: 'onboarding.done',
};

export interface SoulOnboardingQuestionView {
  readonly step: SoulOnboardingStep; readonly key: string;
  readonly allowSkip: boolean; readonly requiresConsent: boolean; readonly multiple: boolean;
}
export interface SoulOnboardingConsentView {
  readonly granted: boolean; readonly consentId: string | null; readonly purpose: string;
  readonly scopes: readonly string[]; readonly grantedAt: string | null;
}
export type OnboardingAiReason =
  | 'READY' | 'NO_ENDPOINT' | 'NO_CREDENTIAL' | 'NO_ATTESTATION' | 'INVALID_TIMEOUT' | 'INVALID_MODEL' | 'INVALID_ENDPOINT' | 'UNKNOWN';

export interface SoulOnboardingView {
  readonly status: SoulOnboardingDisplayStatus;
  readonly step: SoulOnboardingStep;
  readonly locale: 'en' | 'fr';
  readonly question: SoulOnboardingQuestionView | null;
  readonly progress: { readonly answered: number; readonly total: number };
  readonly consent: SoulOnboardingConsentView;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly completedAt: string | null;
  /**
   * True when an engine is configured and would accept a call. This is a readiness fact, not a
   * promise: a call can still fail at request time and is then reported per-message.
   */
  readonly aiAvailable: boolean;
  /** Why guidance is or is not model-backed. 'READY' when aiAvailable is true. */
  readonly aiReason: OnboardingAiReason;
  /** Whether the onboarding question itself accepts the optional guided conversation. */
  readonly guidanceAvailable: boolean;
}
export interface SoulOnboardingGuidance {
  readonly step: SoulOnboardingStep;
  /** AI or DETERMINISTIC_FALLBACK — never inferred by the UI. */
  readonly source: 'AI' | 'DETERMINISTIC_FALLBACK';
  readonly reason: string;
  readonly aiGenerated: boolean;
  readonly content: string;
  readonly turns: { readonly used: number; readonly maximum: number };
  /** The onboarding state machine is untouched by guidance: this is the step still being asked. */
  readonly stepUnchanged: true;
}
export interface SoulOnboardingCompletion {
  readonly view: SoulOnboardingView;
  readonly objective: string | null;
}
export interface SoulOnboardingAdminSummary {
  readonly workspaceId: string; readonly status: SoulOnboardingDisplayStatus;
  readonly step: SoulOnboardingStep; readonly startedAt: string | null;
  readonly updatedAt: string | null; readonly completedAt: string | null;
}

const onboardingPurpose = 'Soul onboarding — consented context';
const onboardingScopes = ['context:read', 'context:write'] as const;

function onboardQuestion(step: SoulOnboardingStep): SoulOnboardingQuestionView | null {
  if (step === 'DONE') return null;
  return {
    step, key: onboardingQuestionKeys[step],
    allowSkip: step !== 'CONSENT',
    requiresConsent: (SOUL_ONBOARDING_CONTENT_STEPS as readonly string[]).includes(step),
    multiple: step === 'OBJECTIVES' || step === 'PREFERENCES',
  };
}

/**
 * Pre-mission Soul onboarding: one deterministic question at a time, progress persisted per
 * user/workspace. Answers are only memorised as consented user_context facts after an explicit
 * consent step; no answer content is stored in the onboarding progress row and the /v1/soul/converse
 * contract (operationId + attemptId) is never called before a mission exists.
 */
export class SoulOnboardingService {
  constructor(private readonly store: QeyNoxStore, private readonly soul: SoulService, private readonly guidance: GuidedOnboardingPort) {}

  async view(actor: Principal): Promise<SoulOnboardingView> {
    return this.viewOf(actor, await this.store.getOnboarding(actor.workspaceId, actor.userId));
  }

  async start(actor: Principal, locale?: string): Promise<SoulOnboardingView> {
    const existing = await this.store.getOnboarding(actor.workspaceId, actor.userId);
    if (existing) return this.viewOf(actor, existing);
    const now = new Date().toISOString();
    const record: SoulOnboardingRecord = {
      id: newId(), userId: actor.userId, workspaceId: actor.workspaceId, status: 'IN_PROGRESS',
      step: 'WELCOME', locale: locale === 'fr' ? 'fr' : 'en', skippedSteps: [],
      startedAt: now, updatedAt: now,
    };
    await this.store.putOnboarding(record);
    return this.viewOf(actor, record);
  }

  async answer(actor: Principal, step: SoulOnboardingStep, value: string | readonly string[]): Promise<SoulOnboardingView> {
    const record = await this.requireMutable(actor);
    if (record.step !== step) throw new DomainError('INVALID_STATE', 'Onboarding step does not match the current question');
    const now = new Date().toISOString();
    if (step === 'WELCOME') return this.advance(actor, record, now);
    if (step === 'LANGUAGE') {
      const language = typeof value === 'string' ? value : '';
      if (language !== 'en' && language !== 'fr') throw new DomainError('INVALID_INPUT', 'Unsupported language');
      return this.advance(actor, { ...record, locale: language }, now);
    }
    if (step === 'CONSENT' || step === 'DONE') throw new DomainError('INVALID_STATE', 'This step is not answered with free text');
    const consent = await this.activeConsent(actor, record);
    if (!consent) throw new DomainError('DENIED', 'Explicit consent is required before any answer is memorised');
    if (step === 'FIRST_OBJECTIVE') {
      const objective = typeof value === 'string' ? value.trim() : '';
      if (objective.length < 5 || objective.length > 500) throw new DomainError('INVALID_INPUT', 'First objective must be 5–500 characters');
      await this.soul.saveFact(actor, SOUL_FIRST_OBJECTIVE_FACT_KEY, objective, consent.id);
      return this.advance(actor, record, now);
    }
    const contentStep = step as SoulOnboardingContentStep;
    const text = typeof value === 'string' ? value.trim() : value.map(item => String(item).trim()).filter(item => item.length > 0);
    if (typeof text === 'string' ? (text.length < 2 || text.length > 500) : (text.length === 0 || text.length > 8 || text.some(item => item.length > 500))) {
      throw new DomainError('INVALID_INPUT', 'Answer must be non-empty and reasonably sized');
    }
    await this.soul.saveFact(actor, SOUL_ONBOARDING_FACT_KEYS[contentStep], text, consent.id);
    return this.advance(actor, record, now);
  }

  async skip(actor: Principal, step: SoulOnboardingStep): Promise<SoulOnboardingView> {
    const record = await this.requireMutable(actor);
    if (record.step !== step) throw new DomainError('INVALID_STATE', 'Onboarding step does not match the current question');
    if (step === 'CONSENT') throw new DomainError('INVALID_STATE', 'Consent cannot be skipped into memory');
    const now = new Date().toISOString();
    const skipped = record.skippedSteps.includes(step) ? record.skippedSteps : [...record.skippedSteps, step];
    return this.advance(actor, { ...record, skippedSteps: skipped }, now);
  }

  async grantOnboardingConsent(actor: Principal, granted: boolean): Promise<SoulOnboardingView> {
    const record = await this.requireMutable(actor);
    if (!granted) {
      if (record.step !== 'CONSENT') return this.pause(actor);
      const next: SoulOnboardingRecord = { ...record, step: 'FIRST_OBJECTIVE', skippedSteps: [...new Set([...record.skippedSteps, ...SOUL_ONBOARDING_CONTENT_STEPS])], updatedAt: new Date().toISOString() };
      await this.store.putOnboarding(next);
      return this.viewOf(actor, next);
    }
    const consent = await this.soul.grantConsent(actor, onboardingPurpose, [...onboardingScopes]);
    const now = new Date().toISOString();
    const withConsent: SoulOnboardingRecord = { ...record, consentId: consent.id, updatedAt: now };
    // Restoring a revoked consent while answering a later question keeps the current question.
    if (record.step === 'CONSENT') return this.advance(actor, withConsent, now);
    await this.store.putOnboarding(withConsent);
    return this.viewOf(actor, withConsent);
  }

  async pause(actor: Principal): Promise<SoulOnboardingView> {
    const record = await this.requireRecord(actor);
    if (record.status === 'COMPLETED') return this.viewOf(actor, record);
    const now = new Date().toISOString();
    const next: SoulOnboardingRecord = { ...record, status: 'PAUSED', updatedAt: now };
    await this.store.putOnboarding(next);
    return this.viewOf(actor, next);
  }

  async resume(actor: Principal): Promise<SoulOnboardingView> {
    const record = await this.requireRecord(actor);
    if (record.status === 'COMPLETED') return this.viewOf(actor, record);
    const now = new Date().toISOString();
    const next: SoulOnboardingRecord = { ...record, status: 'IN_PROGRESS', dismissedAt: undefined, updatedAt: now };
    await this.store.putOnboarding(next);
    return this.viewOf(actor, next);
  }

  async dismiss(actor: Principal): Promise<SoulOnboardingView> {
    const record = await this.requireRecord(actor);
    if (record.status === 'COMPLETED') return this.viewOf(actor, record);
    const now = new Date().toISOString();
    const next: SoulOnboardingRecord = { ...record, status: 'DISMISSED', dismissedAt: now, updatedAt: now };
    await this.store.putOnboarding(next);
    return this.viewOf(actor, next);
  }

  async complete(actor: Principal, objective?: string): Promise<SoulOnboardingCompletion> {
    const record = await this.requireRecord(actor);
    if (record.status === 'COMPLETED') return { view: await this.viewOf(actor, record), objective: null };
    if (record.step !== 'FIRST_OBJECTIVE' && record.step !== 'DONE') {
      throw new DomainError('INVALID_STATE', 'Onboarding must reach the first-objective step before completion');
    }
    const trimmed = objective?.trim() ?? '';
    if (record.step === 'FIRST_OBJECTIVE' && trimmed.length === 0) throw new DomainError('INVALID_INPUT', 'First objective is required');
    let saved: string | null = null;
    if (trimmed.length > 0) {
      if (trimmed.length < 5 || trimmed.length > 500) throw new DomainError('INVALID_INPUT', 'First objective must be 5–500 characters');
      const consent = await this.activeConsent(actor, record);
      if (consent) await this.soul.saveFact(actor, SOUL_FIRST_OBJECTIVE_FACT_KEY, trimmed, consent.id);
      saved = trimmed;
    }
    const now = new Date().toISOString();
    const next: SoulOnboardingRecord = { ...record, status: 'COMPLETED', step: 'DONE', completedAt: now, updatedAt: now };
    await this.store.putOnboarding(next);
    return { view: await this.viewOf(actor, next), objective: saved };
  }

  async createFirstMission(actor: Principal, objective: string) {
    const text = objective.trim();
    if (text.length < 5 || text.length > 500) throw new DomainError('INVALID_INPUT', 'First objective must be 5–500 characters');
    const digest = createHash('sha256').update(text).digest('hex');
    return this.store.db.transaction(async tx => {
      const [row] = await tx.select().from(soulOnboarding)
        .where(and(eq(soulOnboarding.workspaceId, actor.workspaceId), eq(soulOnboarding.userId, actor.userId))).for('update').limit(1);
      if (!row) throw new DomainError('NOT_FOUND', 'Onboarding has not started');
      const key = 'soul:first-mission:' + row.id;
      const [prior] = await tx.select().from(commandIds).where(and(eq(commandIds.workspaceId, actor.workspaceId), eq(commandIds.commandKey, key))).limit(1);
      const scoped = new QeyNoxStore(tx as unknown as QeyNoxDatabase);
      if (prior) {
        if (prior.outcome.objectiveDigest !== digest) throw new DomainError('CONFLICT', 'First mission already created with a different objective');
        return scoped.getOperation(actor, prior.operationId as ID);
      }
      if (row.status !== 'IN_PROGRESS' || row.step !== 'FIRST_OBJECTIVE') throw new DomainError('INVALID_STATE', 'Onboarding must be ready for the first mission');
      const operation = await scoped.createOperation(actor, text.slice(0, 200), text, []);
      await new SoulOnboardingService(scoped, this.soul.withStore(scoped), this.guidanceService()).complete(actor, text);
      await tx.insert(commandIds).values({ id: newId(), workspaceId: actor.workspaceId, operationId: operation.id, commandKey: key, outcome: { objectiveDigest: digest }, createdAt: new Date().toISOString() });
      return operation;
    });
  }

  async adminSummaries(userId: ID): Promise<readonly SoulOnboardingAdminSummary[]> {
    const records = await this.store.listOnboardingForUser(userId);
    return records.map(record => ({
      workspaceId: record.workspaceId, status: record.status, step: record.step,
      startedAt: record.startedAt, updatedAt: record.updatedAt, completedAt: record.completedAt ?? null,
    }));
  }

  private async advance(actor: Principal, record: SoulOnboardingRecord, now: string): Promise<SoulOnboardingView> {
    const next: SoulOnboardingRecord = { ...record, step: onboardingNext[record.step], updatedAt: now };
    await this.store.putOnboarding(next);
    return this.viewOf(actor, next);
  }

  private async activeConsent(actor: Principal, record: SoulOnboardingRecord): Promise<Consent | undefined> {
    if (!record.consentId) return undefined;
    const consents = await this.store.getConsents(actor.workspaceId, actor.userId);
    const consent = consents.find(item => item.id === record.consentId);
    if (!consent || !isConsentActive(consent, new Date().toISOString())) return undefined;
    return consent.scopes.includes('context:write') ? consent : undefined;
  }

  private async viewOf(actor: Principal, record: SoulOnboardingRecord | undefined): Promise<SoulOnboardingView> {
    const consents = await this.store.getConsents(actor.workspaceId, actor.userId);
    const consent = record?.consentId ? consents.find(item => item.id === record.consentId) : undefined;
    const granted = Boolean(consent && isConsentActive(consent, new Date().toISOString()) && consent.scopes.includes('context:write'));
    const step: SoulOnboardingStep = record?.step ?? 'WELCOME';
    const index = soulOnboardingStepOrder.indexOf(step);
    return {
      status: record?.status ?? 'NOT_STARTED',
      step,
      locale: record?.locale ?? 'en',
      question: onboardQuestion(step),
      progress: { answered: Math.max(0, index), total: SOUL_ONBOARDING_STEPS.length - 1 },
      consent: {
        granted, consentId: record?.consentId ?? null, purpose: onboardingPurpose,
        scopes: [...onboardingScopes], grantedAt: consent?.grantedAt ?? null,
      },
      startedAt: record?.startedAt ?? null, updatedAt: record?.updatedAt ?? null,
      completedAt: record?.completedAt ?? null,
      ...(await this.guidanceReadiness()),
    };
  }

  /**
   * The scoped path builds a service for one transaction. It reuses the same engine port; a missing
   * profile surfaces as NOT_CONFIGURED and the guide converts it into the deterministic fallback.
   */
  private guidanceService(): GuidedOnboardingPort {
    return new GuidedOnboardingService(this.soul.enginePort, () => this.soul.activeSoulProfile());
  }

  /**
   * Readiness is reported exactly as the engine itself reports it. An adapter that cannot attest
   * readiness (or no engine at all) yields aiAvailable:false, and the UI then says so instead of
   * presenting model output that will never arrive.
   */
  private async guidanceReadiness(): Promise<Pick<SoulOnboardingView, 'aiAvailable' | 'aiReason' | 'guidanceAvailable'>> {
    const report = this.soul.enginePort.isAvailable?.();
    const aiAvailable = report?.available === true;
    return {
      aiAvailable,
      aiReason: aiAvailable ? 'READY' : (report?.reason ?? 'UNKNOWN'),
      guidanceAvailable: aiAvailable,
    };
  }

  /**
   * Optional guided help for the question currently being asked.
   *
   * Deliberately narrow. It cannot advance the state machine, cannot write a fact, and refuses any
   * step that is not the live question. Answers used as grounding come from the consented fact store
   * via `viewContext`, so a revoked consent removes that grounding without deleting anything, and
   * guidance never reads another workspace.
   */
  async guide(actor: Principal, input: { readonly message?: string; readonly history?: readonly GuidedTurn[]; readonly attemptKey: string }): Promise<SoulOnboardingGuidance> {
    const record = await this.requireRecord(actor);
    if (record.status === 'COMPLETED' || record.status === 'DISMISSED') {
      throw new DomainError('INVALID_STATE', 'Onboarding guidance is only available while onboarding is open');
    }
    const step = record.step;
    if (!isGuidedStep(step)) {
      throw new DomainError('INVALID_STATE', 'The current onboarding step does not accept guided input');
    }
    const readiness = await this.guidanceReadiness();
    const facts = await this.soul.viewContext(actor);
    const answers = facts
      .filter(fact => !fact.deletedAt && Object.values(SOUL_ONBOARDING_FACT_KEYS).includes(fact.key as never))
      .map(fact => ({ step: fact.key, value: typeof fact.value === 'string' ? fact.value : String(fact.value ?? '') }));
    const outcome = await this.guidance.guide(actor, {
      onboardingId: record.id,
      step,
      message: input.message,
      answers,
      history: input.history ?? [],
      attemptKey: input.attemptKey,
      locale: record.locale,
    });
    return {
      step,
      source: outcome.source,
      reason: outcome.reason,
      aiGenerated: outcome.aiGenerated,
      content: outcome.content,
      turns: outcome.turns,
      stepUnchanged: true,
    };
  }

  private async requireRecord(actor: Principal): Promise<SoulOnboardingRecord> {
    const record = await this.store.getOnboarding(actor.workspaceId, actor.userId);
    if (!record) throw new DomainError('NOT_FOUND', 'Onboarding has not started');
    return record;
  }

  private async requireMutable(actor: Principal): Promise<SoulOnboardingRecord> {
    const record = await this.requireRecord(actor);
    if (record.status === 'COMPLETED' || record.status === 'DISMISSED') {
      throw new DomainError('INVALID_STATE', 'Onboarding is not in progress');
    }
    return record;
  }
}
