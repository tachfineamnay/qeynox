'use client';
import { useActionState } from 'react';
import { confirmRecoveryAction, confirmVerificationAction, createMission, login, registerAction, requestRecoveryAction, requestVerificationAction, type IdentityState } from '../lib/actions';
import { copy, type Locale } from '../lib/copy';
import { Feedback } from './ui';
import { registrationCopy } from '../lib/registration-copy';
import { resendIsError, verificationResendCopy } from '../lib/verification-resend';
export function errorText(code: string, lang: Locale) {
  const t = copy[lang];
  return code === 'NOT_CONFIGURED' ? t.notConfigured : code === 'SESSION_REQUIRED' ? t.signInRequired : code === 'DENIED' ? t.denied : code === 'INVALID_INPUT' ? t.invalid : code === 'UNKNOWN_OUTCOME' ? t.unknown : t.error;
}
export function MissionForm({ lang, enabled }: { lang: Locale; enabled: boolean }) {
  const t = copy[lang]; const [state, action, pending] = useActionState(createMission, { code: '' });
  return <form action={action}><input type="hidden" name="locale" value={lang}/><label htmlFor="goal">{t.goal}</label><p id="goal-hint" className="muted">{t.goalHint}</p><textarea id="goal" name="goal" minLength={5} maxLength={5000} required rows={4} placeholder={t.placeholder} aria-describedby="goal-hint draft-note" disabled={!enabled || pending}/><details className="qx-constraints"><summary>{t.constraintsLabel}</summary><p id="constraints-hint" className="muted">{t.constraintsHint}</p><label className="qx-sr-only" htmlFor="constraints">{t.constraintsLabel}</label><textarea id="constraints" name="constraints" rows={4} maxLength={20000} placeholder={t.constraintsPlaceholder} aria-describedby="constraints-hint" disabled={!enabled || pending}/></details><div className="form-bottom"><p id="draft-note" className="muted">{t.draftNote}</p><button disabled={!enabled || pending}>{pending ? t.saving : t.save}</button></div>{state.code && <Feedback title={errorText(state.code, lang)} error/>}</form>;
}
export function loginErrorText(code: string, lang: Locale): string {
  // A refused sign-in is almost always credentials, not authorization. Avoid inventing an account
  // oracle: one honest message covers both, and never claims a permission problem for a typo.
  return code === 'DENIED' ? copy[lang].credentialsDenied : errorText(code, lang);
}
export function LoginForm({ lang }: { lang: Locale }) {
  const t = copy[lang]; const [state, action, pending] = useActionState(login, { code: '' });
  return <form action={action} className="login-form"><input type="hidden" name="locale" value={lang}/><label htmlFor="email">{t.email}</label><input id="email" name="email" type="email" autoComplete="username" required disabled={pending}/><label htmlFor="password">{t.password}</label><input id="password" name="password" type="password" autoComplete="current-password" maxLength={256} required disabled={pending}/><button disabled={pending}>{pending ? t.pending : t.signin}</button>{state.code && <Feedback title={loginErrorText(state.code, lang)} error/>}<p className="muted"><a href={'/' + lang + '/account/register'}>{t.noAccount}</a></p><p className="muted">{t.sessionNote}</p></form>;
}

// ---------------------------------------------------------------------------------------------
// MISSION A04 — registration, verification and recovery forms.
//
// These never render a success state for a request that was not delivered: when the API reports a
// link was issued but no transport sent it, the form says exactly that instead of "check your inbox".
// ---------------------------------------------------------------------------------------------

/** Maps an identity error code to customer-facing copy, including the recovery states. */
export function identityErrorText(code: string, lang: Locale): string {
  const t = copy[lang];
  if (code === 'BUDGET_EXHAUSTED') return t.tooManyAttempts;
  if (code === 'CONFLICT') return t.linkUsed;
  if (code === 'DENIED') return t.accountSuspended;
  if (code === 'INVALID_INPUT') return t.invalid;
  return errorText(code, lang);
}

/**
 * A21.05 — register-specific refusals. Duplicate e-mail (CONFLICT) stays generic and non-enumerating;
 * NOT_CONFIGURED here means the policy closed between page render and submit.
 */
export function registerErrorText(code: string, lang: Locale): string {
  const r = registrationCopy[lang];
  if (code === 'INVITATION_INVALID') return r.invitationInvalid;
  if (code === 'CONFLICT') return r.conflict;
  if (code === 'NOT_CONFIGURED') return r.closedAtSubmit;
  return identityErrorText(code, lang);
}

/**
 * Rendered only when the API's registration policy accepts registrations (A21.05). The invitation
 * field is required when the policy is INVITE_ONLY, and shown (pre-filled) in OPEN mode only when the
 * visitor arrived through an invitation link, so the invited workspace is enrolled in the beta.
 */
export function RegisterForm({ lang, invitationRequired, invitation }: { lang: Locale; invitationRequired: boolean; invitation: string }) {
  const t = copy[lang]; const r = registrationCopy[lang]; const [state, action, pending] = useActionState(registerAction, { kind: 'IDLE' } as IdentityState);
  const showInvitation = invitationRequired || invitation !== '';
  return <form action={action} className="login-form"><input type="hidden" name="locale" value={lang}/>
    <p className="muted">{t.createAccountNote}</p>
    {showInvitation && <>
      <label htmlFor="register-invitation">{r.invitationLabel}</label>
      <p id="invitation-rule" className="muted">{invitationRequired ? r.invitationHint : r.invitationEnrollsHint}</p>
      <input id="register-invitation" name="invitationToken" type="text" autoComplete="off" spellCheck={false} defaultValue={invitation} required={invitationRequired} maxLength={256} aria-describedby="invitation-rule" disabled={pending}/>
    </>}
    <label htmlFor="register-email">{t.email}</label>
    <input id="register-email" name="email" type="email" autoComplete="email" required disabled={pending}/>
    <label htmlFor="register-password">{t.password}</label>
    <p id="password-rule" className="muted">{t.passwordRule}</p>
    <input id="register-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required aria-describedby="password-rule" disabled={pending}/>
    <label htmlFor="register-workspace">{t.workspaceName}</label>
    <input id="register-workspace" name="workspaceName" type="text" autoComplete="organization" minLength={2} maxLength={120} required disabled={pending}/>
    <button disabled={pending}>{pending ? t.pending : t.register}</button>
    {state.kind === 'ERROR' && <Feedback title={registerErrorText(state.code, lang)} error/>}
    <p className="muted"><a href={'/' + lang + '/account'}>{t.haveAccount}</a></p>
  </form>;
}

export function RecoveryRequestForm({ lang }: { lang: Locale }) {
  const t = copy[lang]; const [state, action, pending] = useActionState(requestRecoveryAction, { kind: 'IDLE' } as IdentityState);
  return <form action={action} className="login-form"><input type="hidden" name="locale" value={lang}/>
    <p className="muted">{t.resetRequestNote}</p>
    <label htmlFor="recovery-email">{t.email}</label>
    <input id="recovery-email" name="email" type="email" autoComplete="email" required disabled={pending}/>
    <button disabled={pending}>{pending ? t.pending : t.resetRequest}</button>
    {state.kind === 'CODE_SENT' && <Feedback title={t.recoverySent}>{state.delivered ? undefined : t.deliveryNotConfigured}</Feedback>}
    {state.kind === 'ERROR' && <Feedback title={identityErrorText(state.code, lang)} error/>}
    <p className="muted"><a href={'/' + lang + '/account'}>{t.haveAccount}</a></p>
  </form>;
}

export function RecoveryConfirmForm({ lang, token }: { lang: Locale; token: string }) {
  const t = copy[lang]; const [state, action, pending] = useActionState(confirmRecoveryAction, { kind: 'IDLE' } as IdentityState);
  return <form action={action} className="login-form"><input type="hidden" name="locale" value={lang}/><input type="hidden" name="token" value={token}/>
    <p className="muted">{t.resetNote}</p>
    <label htmlFor="recovery-password">{t.resetPassword}</label>
    <p id="recovery-rule" className="muted">{t.passwordRule}</p>
    <input id="recovery-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required aria-describedby="recovery-rule" disabled={pending}/>
    <button disabled={pending}>{pending ? t.pending : t.resetPassword}</button>
    {state.kind === 'ERROR' && <Feedback title={identityErrorText(state.code, lang)} error/>}
  </form>;
}

export function VerificationForm({ lang, token }: { lang: Locale; token: string }) {
  const t = copy[lang]; const [state, action, pending] = useActionState(confirmVerificationAction, { kind: 'IDLE' } as IdentityState);
  if (state.kind === 'DONE') return <Feedback title={t.verifyDone}><a href={'/' + lang + '/account'}>{t.haveAccount}</a></Feedback>;
  return <form action={action} className="login-form"><input type="hidden" name="locale" value={lang}/><input type="hidden" name="token" value={token}/>
    <p className="muted">{t.verifyNote}</p>
    <button disabled={pending}>{pending ? t.pending : t.verifyAction}</button>
    {state.kind === 'ERROR' && <Feedback title={identityErrorText(state.code, lang)} error/>}
  </form>;
}

/**
 * A21.06 — resend for the signed-in account. Shows the server's exact outcome: accepted by the
 * provider, transport not configured, delivery failed, already verified, or too many requests.
 */
export function ResendVerification({ lang }: { lang: Locale }) {
  const t = copy[lang]; const r = verificationResendCopy[lang];
  const [state, action, pending] = useActionState(requestVerificationAction, { kind: 'IDLE' } as IdentityState);
  return <form action={action} data-resend-state={state.kind === 'VERIFICATION_RESEND' ? state.view : state.kind}>{pending
    ? <button disabled>{t.pending}</button>
    : <button>{t.resendVerification}</button>}
    {state.kind === 'VERIFICATION_RESEND' && <Feedback title={r.title[state.view]} error={resendIsError(state.view)}>{r.body[state.view]}</Feedback>}
    {state.kind === 'ERROR' && <Feedback title={identityErrorText(state.code, lang)} error/>}
  </form>;
}
