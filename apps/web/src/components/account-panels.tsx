'use client';
import { useState, useTransition } from 'react';
import { Feedback } from './ui';
import { copy, type Locale } from '../lib/copy';
import { settingsCopy } from '../lib/settings-copy';
import { changePasswordAction, cancelDeletionAction, requestDeletionAction, revokeOtherSessionsAction, revokeSessionAction, updateLocaleAction } from '../lib/account-actions';
import type { DeletionRequest, SessionView } from '../lib/workspaces';

const fmtDate = (lang: Locale, iso: string | null) =>
  iso ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso)) + ' UTC' : '—';

const failed = (s: ReturnType<typeof settingsCopy>, code: string) =>
  code === 'DENIED' ? s.passwordFailed : code === 'INVALID_INPUT' ? s.reasonTooShort : s.failed;

export function LocaleForm({ lang, current }: { lang: Locale; current: string }) {
  const s = settingsCopy(lang);
  const [pending, start] = useTransition();
  const [code, setCode] = useState('');
  return (
    <form onSubmit={event => {
      event.preventDefault();
      const form = event.currentTarget;
      const value = String(new FormData(form).get('locale') ?? 'en');
      start(async () => { const result = await updateLocaleAction(value); setCode(result.code); if (result.code === 'OK') window.location.reload(); });
    }}>
      <label htmlFor="account-locale">{s.locale}</label>
      <select id="account-locale" name="locale" defaultValue={current} disabled={pending}>
        <option value="en">English</option>
        <option value="fr">Français</option>
      </select>
      <button disabled={pending}>{s.saveLocale}</button>
      {code === 'OK' && <Feedback title={s.ok} />}
      {code && code !== 'OK' && <Feedback error title={s.failed} />}
    </form>
  );
}

export function PasswordForm({ lang }: { lang: Locale }) {
  const t = copy[lang]; const s = settingsCopy(lang);
  const [pending, start] = useTransition();
  const [state, setState] = useState<{ code: string; revoked?: number }>({ code: '' });
  return (
    <form onSubmit={event => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      start(async () => {
        const result = await changePasswordAction({ currentPassword: String(data.get('currentPassword') ?? ''), nextPassword: String(data.get('nextPassword') ?? '') });
        setState(result);
        if (result.code === 'OK') form.reset();
      });
    }} className="login-form">
      <label htmlFor="current-password">{s.currentPassword}</label>
      <input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required maxLength={256} />
      <label htmlFor="next-password">{s.nextPassword}</label>
      <p id="next-password-rule" className="muted">{t.passwordRule}</p>
      <input id="next-password" name="nextPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={256} aria-describedby="next-password-rule" />
      <button disabled={pending}>{pending ? t.pending : s.changePassword}</button>
      {state.code === 'OK' && <Feedback title={s.passwordChanged}>{state.revoked && state.revoked > 0 ? `${state.revoked}` : ''}</Feedback>}
      {state.code && state.code !== 'OK' && <Feedback error title={failed(s, state.code)} />}
    </form>
  );
}

export function SessionList({ lang, sessions }: { lang: Locale; sessions: SessionView[] }) {
  const t = copy[lang]; const s = settingsCopy(lang);
  const [pending, start] = useTransition();
  const [code, setCode] = useState('');
  const act = (fn: () => Promise<{ code: string }>) => start(async () => { const result = await fn(); setCode(result.code); if (result.code === 'OK') window.location.reload(); });
  return (
    <div>
      <ul className="qx-connection-grid">
        {sessions.map(item => (
          <li key={item.id} className="qx-connection-card">
            <div className="qx-connection-head">
              <h3 style={{ fontSize: 16 }}>{item.current ? s.current : s.sessionsTitle}</h3>
              {item.current && <span className="badge info">{s.current}</span>}
            </div>
            <dl className="qx-connection-meta">
              <div><dt>{s.created}</dt><dd>{fmtDate(lang, item.createdAt)}</dd></div>
              <div><dt>{s.lastUsed}</dt><dd>{fmtDate(lang, item.lastUsedAt)}</dd></div>
            </dl>
            {!item.current && <button type="button" className="ghost" disabled={pending} onClick={() => act(() => revokeSessionAction(item.id))}>{s.revoke}</button>}
          </li>
        ))}
      </ul>
      <button type="button" className="ghost" disabled={pending} onClick={() => act(() => revokeOtherSessionsAction())}>{s.revokeOthers}</button>
      <p className="muted">{s.revokeOthersNote}</p>
      {code === 'OK' && <Feedback title={s.revokeOthersDone} />}
      {code && code !== 'OK' && <Feedback error title={s.failed} />}
    </div>
  );
}

export function DeletionPanel({ lang, initial }: { lang: Locale; initial: DeletionRequest | null }) {
  const t = copy[lang]; const s = settingsCopy(lang);
  const [pending, start] = useTransition();
  const [request, setRequest] = useState<DeletionRequest | null>(initial);
  const [code, setCode] = useState('');
  const [outcome, setOutcome] = useState<'REQUESTED' | 'ALREADY_REQUESTED' | ''>('');
  const pendingRequest = request?.status === 'REQUESTED';
  return (
    <div>
      <p className="muted">{s.privacyNote}</p>
      {pendingRequest ? (
        <>
          <Feedback title={s.deletionPending}><time>{fmtDate(lang, request?.createdAt ?? null)}</time></Feedback>
          <button type="button" className="ghost" disabled={pending} onClick={() => start(async () => { const result = await cancelDeletionAction(); setCode(result.code); if (result.code === 'OK' && request) setRequest({ ...request, status: 'CANCELLED' }); })}>{s.deletionCancel}</button>
          {code === 'OK' && <Feedback title={s.deletionCancelled} />}
          {code && code !== 'OK' && <Feedback error title={s.failed} />}
        </>
      ) : (
        <form onSubmit={event => {
          event.preventDefault();
          if (!window.confirm(settingsCopy(lang).deletionConfirm)) return;
          const form = event.currentTarget; const reason = String(new FormData(form).get('reason') ?? '');
          start(async () => {
            const result = await requestDeletionAction(reason);
            setCode(result.code);
            setOutcome(result.outcome ?? '');
            if (result.outcome) window.location.reload();
          });
        }}>
          <label htmlFor="deletion-reason">{s.deletionReason}</label>
          <textarea id="deletion-reason" name="reason" rows={3} maxLength={500} />
          <button disabled={pending}>{pending ? t.pending : s.requestDeletion}</button>
          {outcome === 'ALREADY_REQUESTED' && <Feedback title={s.deletionAlready} />}
          {code && code !== 'OK' && <Feedback error title={s.failed} />}
        </form>
      )}
    </div>
  );
}
