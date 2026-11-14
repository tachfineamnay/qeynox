'use client';
import { useActionState } from 'react';
import { createMission, login } from '../lib/actions';
import { copy, type Locale } from '../lib/copy';
import { Feedback } from './ui';
export function errorText(code: string, lang: Locale) {
  const t = copy[lang];
  return code === 'NOT_CONFIGURED' ? t.notConfigured : code === 'SESSION_REQUIRED' ? t.signInRequired : code === 'DENIED' ? t.denied : code === 'INVALID_INPUT' ? t.invalid : code === 'UNKNOWN_OUTCOME' ? t.unknown : t.error;
}
export function MissionForm({ lang, enabled }: { lang: Locale; enabled: boolean }) {
  const t = copy[lang]; const [state, action, pending] = useActionState(createMission, { code: '' });
  return <form action={action}><input type="hidden" name="locale" value={lang}/><label htmlFor="goal">{t.goal}</label><p id="goal-hint" className="muted">{t.goalHint}</p><textarea id="goal" name="goal" minLength={5} maxLength={5000} required rows={4} placeholder={t.placeholder} aria-describedby="goal-hint draft-note" disabled={!enabled || pending}/><details className="qx-constraints"><summary>{t.constraintsLabel}</summary><p id="constraints-hint" className="muted">{t.constraintsHint}</p><label className="qx-sr-only" htmlFor="constraints">{t.constraintsLabel}</label><textarea id="constraints" name="constraints" rows={4} maxLength={20000} placeholder={t.constraintsPlaceholder} aria-describedby="constraints-hint" disabled={!enabled || pending}/></details><div className="form-bottom"><p id="draft-note" className="muted">{t.draftNote}</p><button disabled={!enabled || pending}>{pending ? t.saving : t.save}</button></div>{state.code && <Feedback title={errorText(state.code, lang)} error/>}</form>;
}
export function LoginForm({ lang }: { lang: Locale }) {
  const t = copy[lang]; const [state, action, pending] = useActionState(login, { code: '' });
  return <form action={action} className="login-form"><input type="hidden" name="locale" value={lang}/><label htmlFor="email">{t.email}</label><input id="email" name="email" type="email" autoComplete="username" required disabled={pending}/><label htmlFor="password">{t.password}</label><input id="password" name="password" type="password" autoComplete="current-password" maxLength={256} required disabled={pending}/><button disabled={pending}>{pending ? t.pending : t.signin}</button>{state.code && <Feedback title={errorText(state.code, lang)} error/>}<p className="muted">{t.sessionNote}</p></form>;
}
