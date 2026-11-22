'use client';
import { useActionState, useState } from 'react';
import { issueRegistrationAction, revokeRegistrationAction, recoverOperationAction, type OperationActionState } from '../lib/beta-operations-actions';
import { copy, type Locale } from '../lib/copy';
import { betaOperationsCopy } from '../lib/beta-operations-copy';
const initial: OperationActionState = { status: 'idle' };

function ActionResult({ state, lang }: { state: OperationActionState; lang: Locale }) {
  return state.status === 'idle' ? null : <div role={state.status === 'error' ? 'alert' : 'status'} className={'notice ' + (state.status === 'ok' ? 'success' : 'danger')}><strong>{state.status === 'ok' ? betaOperationsCopy[lang].accepted : copy[lang].resultError}</strong>{state.code ? <p><code>{state.code}</code></p> : null}{state.code==='UNKNOWN_OUTCOME'?<p>{betaOperationsCopy[lang].unknownOutcome}</p>:null}</div>;
}
export function RecoveryForm({ lang, id, workspaceId, operationId, action }: { lang: Locale; id: string; workspaceId: string; operationId?: string; action: 'EXPEDITE_OUTBOX' | 'ESCALATE_INCIDENT' }) {
  const [state, submit, pending] = useActionState(recoverOperationAction, initial);
  const t = copy[lang], b = betaOperationsCopy[lang];
  return <form action={submit} className="form">
    <input type="hidden" name="lang" value={lang} /><input type="hidden" name="id" value={id} /><input type="hidden" name="workspaceId" value={workspaceId} /><input type="hidden" name="operationId" value={operationId ?? ''} /><input type="hidden" name="action" value={action} />
    <label className="field"><span>{t.justification}</span><textarea name="reason" minLength={10} maxLength={500} required rows={2} /></label>
    <label><input type="checkbox" name="confirm" required /> {b.confirm}</label>
    <button className="button secondary" disabled={pending || state.status === 'ok' || state.code === 'UNKNOWN_OUTCOME'}>{pending ? t.loading : action === 'EXPEDITE_OUTBOX' ? b.expedite : b.escalate}</button>
    <ActionResult state={state} lang={lang} />
  </form>;
}
export function RevokeRegistrationForm({ lang, id }: { lang: Locale; id: string }) {
  const [state, submit, pending] = useActionState(revokeRegistrationAction, initial);
  return <form action={submit} className="form"><input type="hidden" name="lang" value={lang} /><input type="hidden" name="id" value={id} />
    <label className="field"><span>{copy[lang].justification}</span><input name="reason" required minLength={10} maxLength={500} /></label>
    <label><input name="confirm" type="checkbox" required /> {betaOperationsCopy[lang].confirm}</label>
    <button className="button danger" disabled={pending || state.status === 'ok' || state.code === 'UNKNOWN_OUTCOME'}>{pending ? copy[lang].loading : betaOperationsCopy[lang].revoke}</button><ActionResult state={state} lang={lang} />
  </form>;
}
export function RegistrationInvitationForm({ lang }: { lang: Locale }) {
  const [state, submit, pending] = useActionState(issueRegistrationAction, initial);
  const [dismissed, dismiss] = useState<string | undefined>();
  const t = copy[lang], b = betaOperationsCopy[lang];
  return <form action={submit} className="card form">
    <h2>{b.issue}</h2><input type="hidden" name="lang" value={lang} />
    <label className="field"><span>{t.email}</span><input type="email" name="email" required maxLength={320} autoComplete="off" /></label>
    <label className="field"><span>{b.expires}</span><input type="datetime-local" name="betaExpiresAt" required /></label>
    <label className="field"><span>{t.betaMissionQuota}</span><input name="missionQuota" type="number" min={1} max={10000} step={1} required /></label>
    <label className="field"><span>{t.betaConcurrentLimit}</span><input name="concurrentLimit" type="number" min={1} max={100} step={1} required /></label>
    <label className="field"><span>{t.betaSpendCap}</span><input name="maxProviderSpendMinor" type="number" min={0} max={100000000} step={1} required /></label>
    <label className="field"><span>{t.betaCurrency}</span><input name="currency" minLength={3} maxLength={3} pattern="[A-Za-z]{3}" required /></label>
    <label className="field"><span>{t.justification}</span><textarea name="reason" minLength={10} maxLength={500} required rows={3} /></label>
    <label><input type="checkbox" name="confirm" required /> {b.confirm}</label>
    <button className="button" disabled={pending || state.code === 'UNKNOWN_OUTCOME'}>{pending ? t.loading : b.issue}</button>
    {state.status === 'error' ? <ActionResult state={state} lang={lang} /> : null}
    {state.status === 'ok' && state.token !== dismissed ? <div className="notice warning" role="status"><strong>{b.oneTime}</strong><p><code>{state.token}</code></p><p>{b.link}</p><code>{state.registrationPath}</code><p><button type="button" className="button secondary" onClick={() => dismiss(state.token)}>{b.dismiss}</button></p></div> : null}
  </form>;
}
