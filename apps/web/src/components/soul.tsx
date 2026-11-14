import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, Feedback } from './ui';
import { copy, soulCopy, type Locale } from '../lib/copy';
import {
  answerOnboarding, completeOnboarding, consentOnboarding, createMissionFromOnboarding,
  deleteAllContext, deleteContextFact, dismissOnboarding, pauseOnboarding, resumeOnboarding,
  saveContextFact, skipOnboarding, startOnboarding, revokeContextConsent,
} from '../lib/soul-actions';

export interface SoulOnboardingViewData {
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'DISMISSED';
  step: 'WELCOME' | 'LANGUAGE' | 'CONSENT' | 'ACTIVITY' | 'OBJECTIVES' | 'NEEDS' | 'PREFERENCES' | 'FIRST_OBJECTIVE' | 'DONE';
  locale: 'en' | 'fr';
  progress: { answered: number; total: number };
  consent: { granted: boolean; consentId: string | null; purpose: string; scopes: readonly string[]; grantedAt: string | null };
  deterministic: true;
  aiAvailable: false;
  aiReason: string;
}
export interface SoulFact { id: string; key: string; value: unknown; consentId: string; updatedAt: string }
export interface SoulConsent { id: string; purpose: string; scopes: readonly string[]; grantedAt: string; revokedAt?: string; expiresAt?: string }

function progressText(view: SoulOnboardingViewData, lang: Locale): string {
  return soulCopy[lang].progress + ': ' + view.progress.answered + '/' + view.progress.total;
}
function questionText(step: SoulOnboardingViewData['step'], lang: Locale): string {
  const c = soulCopy[lang];
  const map: Record<string, string> = {
    ACTIVITY: c.activity, OBJECTIVES: c.objectives, NEEDS: c.needs,
    PREFERENCES: c.preferences, FIRST_OBJECTIVE: c.firstObjective, LANGUAGE: c.languageQuestion,
    CONSENT: c.consentQuestion, WELCOME: c.welcome,
  };
  return map[step] ?? c.title;
}
function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function SoulOnboarding({ lang, view, facts, consents, failure }: {
  lang: Locale;
  view: SoulOnboardingViewData | null;
  facts: readonly SoulFact[];
  consents: readonly SoulConsent[];
  failure?: string;
}) {
  const t = copy[lang]; const c = soulCopy[lang];
  if (!view) {
    return <Card><h2>{c.title}</h2><p>{failure ? c.error : t.signInRequired}</p>{failure ? <Feedback title={c.error} error>{failure}</Feedback> : <p><Link href={'/' + lang + '/account'}>{t.signin}</Link></p>}</Card>;
  }
  const paused = view.status === 'PAUSED';
  const completed = view.status === 'COMPLETED';
  const dismissed = view.status === 'DISMISSED';
  const inProgress = view.status === 'IN_PROGRESS';
  const step = view.step;
  const formHidden = <input type="hidden" name="locale" value={lang} />;
  const skipPause = step !== 'DONE' && step !== 'CONSENT' && !completed && !dismissed ? (
    <div className="form-bottom">
      <form action={skipOnboarding}><input type="hidden" name="locale" value={lang} /><input type="hidden" name="step" value={step} /><button className="secondary">{c.skip}</button></form>
      {inProgress ? <form action={pauseOnboarding}><input type="hidden" name="locale" value={lang} /><button className="secondary">{c.pause}</button></form> : null}
      <Link href={'/' + lang + '/mydash'}>{c.mydash}</Link>
    </div>
  ) : null;

  let stepBody: ReactNode = null;
  if (view.status === 'NOT_STARTED') {
    stepBody = <><p>{c.welcome}</p><form action={startOnboarding}>{formHidden}<button>{c.start}</button></form></>;
  } else if (paused) {
    stepBody = <><p>{c.paused}</p><p className="muted">{questionText(step, lang)}</p><div className="form-bottom"><form action={resumeOnboarding}>{formHidden}<button>{c.resumed}</button></form><form action={dismissOnboarding}>{formHidden}<button className="secondary">{c.mydash}</button></form></div></>;
  } else if (dismissed) {
    stepBody = <><p>{c.dismissed}</p><div className="form-bottom"><form action={resumeOnboarding}>{formHidden}<button>{c.resumed}</button></form><Link href={'/' + lang + '/mydash'}>{c.mydash}</Link></div></>;
  } else if (completed || step === 'DONE') {
    stepBody = <><p>{c.completed}</p><div className="form-bottom">{completed ? null : <form action={completeOnboarding}>{formHidden}<button>{c.next}</button></form>}<Link className="button" href={'/' + lang + '/mydash'}>{c.mydash}</Link></div></>;
  } else if (step === 'WELCOME') {
    stepBody = <><p>{c.welcome}</p><form action={answerOnboarding}>{formHidden}<input type="hidden" name="step" value="WELCOME" /><input type="hidden" name="value" value="begin" /><button>{c.welcomeStart}</button></form><div className="form-bottom"><Link href={'/' + lang + '/mydash'}>{c.mydash}</Link></div></>;
  } else if (step === 'LANGUAGE') {
    stepBody = (
      <>
        <p>{c.languageQuestion}</p>
        <form action={answerOnboarding}>
          {formHidden}<input type="hidden" name="step" value="LANGUAGE" />
          <label className="choice"><input type="radio" name="value" value="en" defaultChecked={view.locale === 'en'} /> English</label>
          <label className="choice"><input type="radio" name="value" value="fr" defaultChecked={view.locale === 'fr'} /> Français</label>
          <div className="form-bottom"><button>{c.next}</button></div>
        </form>
        {skipPause}
      </>
    );
  } else if (step === 'CONSENT') {
    stepBody = (
      <>
        <p>{c.consentBody}</p>
        <div className="form-bottom">
          <form action={consentOnboarding}>{formHidden}<input type="hidden" name="granted" value="true" /><button>{c.accept}</button></form>
          <form action={consentOnboarding}>{formHidden}<input type="hidden" name="granted" value="false" /><button className="secondary">{c.later}</button></form>
          <Link href={'/' + lang + '/mydash'}>{c.mydash}</Link>
        </div>
      </>
    );
  } else if (step === 'FIRST_OBJECTIVE') {
    stepBody = (
      <>
        <p>{c.firstObjective}</p>
        {!view.consent.granted ? <><Feedback title={c.consentRequired} error /><form action={consentOnboarding}>{formHidden}<input type="hidden" name="granted" value="true" /><button>{c.accept}</button></form></> : (
          <form action={createMissionFromOnboarding}>
            {formHidden}
            <label htmlFor="objective">{c.answer}</label>
            <textarea id="objective" name="objective" minLength={5} maxLength={500} rows={3} required />
            <div className="form-bottom"><button>{c.createMission}</button></div>
          </form>
        )}
        {skipPause}
      </>
    );
  } else {
    stepBody = (
      <>
        <p>{questionText(step, lang)}</p>
        {!view.consent.granted ? <><Feedback title={c.consentRequired} error /><form action={consentOnboarding}>{formHidden}<input type="hidden" name="granted" value="true" /><button>{c.accept}</button></form></> : (
          <form action={answerOnboarding}>
            {formHidden}<input type="hidden" name="step" value={step} />
            <label htmlFor="answer">{c.answer}</label>
            <textarea id="answer" name="value" minLength={2} maxLength={500} rows={3} required />
            <div className="form-bottom"><button>{c.next}</button></div>
          </form>
        )}
        {skipPause}
      </>
    );
  }

  return (
    <>
      <Card>
        <div className="section-heading"><h2>{c.title}</h2><span className="badge neutral">{progressText(view, lang)}</span></div>
        <p>{c.intro}</p>
        <p className="muted">{c.deterministic}</p>
        <p className="badge warning" title={c.deterministic}>{'AI: ' + (view.aiAvailable ? 'available' : 'unavailable') + ' · ' + view.aiReason}</p>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={view.progress.total} aria-valuenow={view.progress.answered}><span style={{ width: Math.round((view.progress.answered / Math.max(1, view.progress.total)) * 100) + '%' }} /></div>
        <h3>{questionText(step, lang)}</h3>
        {stepBody}
      </Card>
      <Card>
        <h2>{c.contextTitle}</h2>
        <p className="muted">{c.contextHint}</p>
        <p><strong>{c.consentState}: </strong>{view.consent.granted ? c.granted : c.notGranted}{view.consent.grantedAt ? ' · ' + new Date(view.consent.grantedAt).toLocaleString(lang) : ''}</p>
        {consents.length === 0 ? <p className="muted">{c.notGranted}</p> : (
          <ul className="event-list">
            {consents.map(consent => (
              <li key={consent.id}>
                <strong>{consent.purpose}</strong>{' '}
                <span className={'badge ' + (consent.revokedAt ? 'danger' : 'success')}>{consent.revokedAt ? c.revoked : c.granted}</span>
                <small>{c.scope + ': ' + consent.scopes.join(', ') + ' · ' + new Date(consent.grantedAt).toLocaleString(lang)}</small>
                {consent.revokedAt ? null : <form action={revokeContextConsent}>{formHidden}<input type="hidden" name="consentId" value={consent.id} /><button className="secondary">{c.revoke}</button></form>}
              </li>
            ))}
          </ul>
        )}
        <h3>{c.contextTitle}</h3>
        {facts.length === 0 ? <p className="muted">{c.contextEmpty}</p> : (
          <ul className="event-list">
            {facts.map(fact => (
              <li key={fact.id}>
                <strong>{fact.key}</strong><small>{new Date(fact.updatedAt).toLocaleString(lang)}</small>
                <form action={saveContextFact}>
                  {formHidden}<input type="hidden" name="key" value={fact.key} /><input type="hidden" name="consentId" value={fact.consentId} />
                  <label htmlFor={'fact-' + fact.id}>{c.answer}</label>
                  <textarea id={'fact-' + fact.id} name="value" rows={2} defaultValue={valueText(fact.value)} />
                  <button className="secondary">{c.save}</button>
                </form>
                <form action={deleteContextFact}>{formHidden}<input type="hidden" name="factId" value={fact.id} /><button className="secondary">{c.delete}</button></form>
              </li>
            ))}
          </ul>
        )}
        {view.consent.granted && view.consent.consentId ? (
          <form action={deleteAllContext}>{formHidden}<button className="secondary">{c.deleteAll}</button></form>
        ) : null}
      </Card>
    </>
  );
}
