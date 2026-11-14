import { and, eq } from 'drizzle-orm';
import {
  DomainError, contextSubset, newId,
  SOUL_FIRST_OBJECTIVE_FACT_KEY, SOUL_ONBOARDING_CONTENT_STEPS, SOUL_ONBOARDING_FACT_KEYS,
  SOUL_ONBOARDING_STEPS, soulOnboardingStepOrder,
  type Consent, type ID, type Principal, type SoulOnboardingContentStep, type SoulOnboardingDisplayStatus,
  type SoulOnboardingRecord, type SoulOnboardingStep, type UserContext,
} from '@qeynox/domain';
import { QeyNoxStore, consents } from '@qeynox/persistence';
import type { EnginePort, EngineOutcome } from '@qeynox/engine';
import { AgentProfileStore } from './profiles';

export class SoulService {
  constructor(private readonly store:QeyNoxStore,private readonly profiles:AgentProfileStore,private readonly engine:EnginePort) {}

  async grantConsent(actor:Principal,purpose:string,scopes:readonly string[],expiresAt?:string):Promise<Consent> {
    if(!scopes.length||!purpose.trim())throw new DomainError('INVALID_INPUT','Consent must name purpose and scopes');
    const consent:Consent={id:newId(),userId:actor.userId,workspaceId:actor.workspaceId,purpose,scopes,grantedAt:new Date().toISOString(),expiresAt,version:1};
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
    if(!permit || permit.revokedAt || (permit.expiresAt && permit.expiresAt<=new Date().toISOString()) || !permit.scopes.includes('context:write'))throw new DomainError('DENIED','Context write consent absent');
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
  /** Pre-mission guidance is deterministic by contract: no language model is invoked yet. */
  readonly deterministic: true;
  readonly aiAvailable: false;
  readonly aiReason: 'PRE_MISSION_CONTRACT';
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
    requiresConsent: (SOUL_ONBOARDING_CONTENT_STEPS as readonly string[]).includes(step) || step === 'FIRST_OBJECTIVE',
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
  constructor(private readonly store: QeyNoxStore, private readonly soul: SoulService) {}

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
    if (!granted) return this.pause(actor);
    const consent = await this.soul.grantConsent(actor, onboardingPurpose, [...onboardingScopes]);
    const now = new Date().toISOString();
    const withConsent: SoulOnboardingRecord = { ...record, consentId: consent.id, updatedAt: now };
    // Restoring a revoked consent while answering a later question keeps the current question.
    return record.step === 'CONSENT' ? this.advance(actor, withConsent, now) : this.viewOf(actor, withConsent);
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
      if (!consent) throw new DomainError('DENIED', 'Explicit consent is required before the objective is memorised');
      await this.soul.saveFact(actor, SOUL_FIRST_OBJECTIVE_FACT_KEY, trimmed, consent.id);
      saved = trimmed;
    }
    const now = new Date().toISOString();
    const next: SoulOnboardingRecord = { ...record, status: 'COMPLETED', step: 'DONE', completedAt: now, updatedAt: now };
    await this.store.putOnboarding(next);
    return { view: await this.viewOf(actor, next), objective: saved };
  }

  async adminSummaries(userId: string): Promise<readonly SoulOnboardingAdminSummary[]> {
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
    if (!consent || consent.revokedAt) return undefined;
    if (consent.expiresAt && consent.expiresAt <= new Date().toISOString()) return undefined;
    return consent.scopes.includes('context:write') ? consent : undefined;
  }

  private async viewOf(actor: Principal, record: SoulOnboardingRecord | undefined): Promise<SoulOnboardingView> {
    const consents = await this.store.getConsents(actor.workspaceId, actor.userId);
    const consent = record?.consentId ? consents.find(item => item.id === record.consentId) : undefined;
    const granted = Boolean(consent && !consent.revokedAt && (!consent.expiresAt || consent.expiresAt > new Date().toISOString()) && consent.scopes.includes('context:write'));
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
      deterministic: true, aiAvailable: false, aiReason: 'PRE_MISSION_CONTRACT',
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
