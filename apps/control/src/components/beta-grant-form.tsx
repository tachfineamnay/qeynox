'use client';
import { useActionState } from 'react';
import { grantBetaAction } from '../lib/actions';
import { copy, type Locale } from '../lib/copy';
import type { BetaGrantState } from '../lib/types';

const initialState: BetaGrantState = { status: 'idle' };

/** A21.02 — grant form. The server decides everything (permission, self-grant, limits); this only collects input. */
export function BetaGrantForm({ lang, workspaceId }: { lang: Locale; workspaceId?: string }) {
  const t = copy[lang];
  const [state, action, pending] = useActionState(grantBetaAction, initialState);
  return (
    <form action={action} className="card form">
      <h2>{t.betaGrant}</h2>
      <p className="muted">{t.betaGrantHint}</p>
      <input type="hidden" name="lang" value={lang} />
      <label className="field"><span>{t.betaWorkspaceId}</span><input name="workspaceId" required defaultValue={workspaceId ?? ''} autoComplete="off" pattern="[A-Za-z0-9_-]{4,120}" /></label>
      <label className="field"><span>{t.betaExpiresAt}</span><input name="expiresAt" type="datetime-local" required /></label>
      <label className="field"><span>{t.betaMissionQuota}</span><input name="missionQuota" type="number" min={1} max={10000} step={1} required defaultValue={10} /></label>
      <label className="field"><span>{t.betaConcurrentLimit}</span><input name="concurrentLimit" type="number" min={1} max={100} step={1} required defaultValue={1} /></label>
      <label className="field"><span>{t.betaSpendCap}</span><input name="maxProviderSpendMinor" type="number" min={0} max={100000000} step={1} required /></label>
      <label className="field"><span>{t.betaCurrency}</span><input name="currency" required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" defaultValue="USD" /></label>
      <label className="field"><span>{t.justification}</span><textarea name="reason" required minLength={10} maxLength={500} rows={3} /></label>
      <button className="button" type="submit" disabled={pending}>{pending ? t.loading : t.betaGrant}</button>
      {state.status === 'ok' ? (
        <div className="notice success" role="status">
          <strong>{t.resultDone}</strong>
          {state.token ? (
            <div className="token-block">
              <p>{t.betaToken}</p>
              <code>{state.token}</code>
              {state.invitationExpiresAt ? <p className="muted">{t.betaInvitationExpires + ': ' + new Date(state.invitationExpiresAt).toLocaleString(lang)}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {state.status === 'error' ? (
        <div className="notice danger" role="alert"><strong>{t.resultError}</strong><p>{t.apiCode + ': ' + (state.code ?? 'UNAVAILABLE')}</p></div>
      ) : null}
    </form>
  );
}
