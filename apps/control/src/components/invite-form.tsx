'use client';
import { useActionState } from 'react';
import { inviteMemberAction } from '../lib/actions';
import { copy, type Locale } from '../lib/copy';
import type { InviteState } from '../lib/types';

const initialState: InviteState = { status: 'idle' };

export function InviteForm({ lang, workspaceId }: { lang: Locale; workspaceId: string }) {
  const t = copy[lang];
  const [state, action, pending] = useActionState(inviteMemberAction, initialState);
  return (
    <form action={action} className="card form">
      <h2>{t.invite}</h2>
      <p className="muted">{t.inviteHint}</p>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <label className="field"><span>{t.email}</span><input name="email" type="email" required autoComplete="off" placeholder="person@example.com" /></label>
      <label className="field"><span>{t.role}</span>
        <select name="role" defaultValue="MEMBER">
          <option value="MEMBER">MEMBER</option>
          <option value="ADMIN">ADMIN</option>
          <option value="OWNER">OWNER</option>
        </select>
      </label>
      <label className="field"><span>{t.justification}</span><textarea name="reason" required minLength={10} maxLength={500} rows={3} /></label>
      <button className="button" type="submit" disabled={pending}>{pending ? t.loading : t.invite}</button>
      {state.status === 'ok' ? (
        <div className="notice success" role="status">
          <strong>{t.deliveryStatus + ': ' + (state.delivery?.email ?? 'BLOCKED')}</strong>
          <p>{t.deliveryReason + ': ' + (state.delivery?.reason ?? 'EMAIL_PROVIDER_NOT_CONFIGURED')}</p>
          {state.token ? (
            <div className="token-block">
              <p>{t.invitationToken}</p>
              <code>{state.token}</code>
              {state.expiresAt ? <p className="muted">{t.expiresAt + ': ' + new Date(state.expiresAt).toLocaleString(lang)}</p> : null}
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
