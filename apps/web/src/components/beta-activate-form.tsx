'use client';
import { useActionState } from 'react';
import type { Locale } from '../lib/copy';
import { betaCopy } from '../lib/beta-copy';
import { activateBeta } from '../lib/beta-actions';
import { Feedback } from './ui';

/** MISSION A21.04 — activation of a pending beta invitation (OWNER/ADMIN only, enforced by the API). */
export function BetaActivateForm({ lang }: { lang: Locale }) {
  const c = betaCopy(lang);
  const [state, action, pending] = useActionState(activateBeta, { code: '' });
  return (
    <form action={action} className="qx-beta-activate">
      <input type="hidden" name="locale" value={lang} />
      <label htmlFor="beta-token">{c.activateLabel}</label>
      <p className="muted" id="beta-token-hint">{c.activateHint}</p>
      <input id="beta-token" name="token" autoComplete="off" spellCheck={false} required minLength={43} maxLength={43} pattern="[A-Za-z0-9_\-]{43}" aria-describedby="beta-token-hint" />
      <button type="submit" disabled={pending}>{pending ? c.activateBusy : c.activateButton}</button>
      {state.code ? <Feedback error={state.code !== 'OK'} title={state.code === 'OK' ? c.activateOk : (c.activateErrors[state.code] ?? state.code)} /> : null}
    </form>
  );
}
