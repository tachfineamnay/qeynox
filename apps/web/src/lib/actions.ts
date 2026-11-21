'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createOperationSchema } from '@qeynox/contracts';
import { z } from 'zod';
import { api, ApiError, operationSchema, sessionSchema, tokenRequestSchema } from './api';
import { locale, type Locale } from './copy';
import { resendViewFromBody, resendViewFromError, type VerificationResendView } from './verification-resend';

/**
 * Where a freshly issued session should land.
 *
 * A brand-new account (and any account whose guided start is unfinished) belongs in Soul first:
 * the guided start is opt-in but recommended, and both sign-in and registration must route the
 * same way. An unavailable onboarding view never blocks access — it falls back to the default.
 */
async function soulAwareDestination(lang: Locale, fallback: string): Promise<string> {
  try {
    const onboarding = await api('/v1/soul/onboarding') as { status?: string };
    if (onboarding.status === 'NOT_STARTED' || onboarding.status === 'IN_PROGRESS' || onboarding.status === 'PAUSED') {
      return '/' + lang + '/soul';
    }
  } catch { /* an unavailable onboarding view never blocks access to MyDash */ }
  return fallback;
}
export type FormState = { code: string };
export async function login(previous: FormState, form: FormData): Promise<FormState> {
  let destination: string;
  try {
    const result = sessionSchema.parse(await api('/v1/auth/login', 'POST', { email: form.get('email'), password: form.get('password') }, false));
    (await cookies()).set('qx-session', JSON.stringify(result), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires: new Date(result.expiresAt) });
    const lang = locale(String(form.get('locale')));
    destination = await soulAwareDestination(lang, '/' + lang + '/mydash');
  } catch (error) { return { code: error instanceof ApiError ? error.code : 'UNAVAILABLE' }; }
  redirect(destination);
}
export async function createMission(previous: FormState, form: FormData): Promise<FormState> {
  let destination: string;
  try {
    const goal = String(form.get('goal') ?? '').trim();
    const constraints = String(form.get('constraints') ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    const input = createOperationSchema.safeParse({ goal, title: goal.slice(0, 200), constraints });
    if (!input.success) return { code: 'INVALID_INPUT' };
    const operation = operationSchema.parse(await api('/v1/operations', 'POST', input.data));
    destination = `/${locale(String(form.get('locale')))}/missions/${encodeURIComponent(operation.id)}`;
  } catch (error) { return { code: error instanceof ApiError ? error.code : 'UNKNOWN_OUTCOME' }; }
  redirect(destination);
}
export async function logout(form: FormData) {
  let unconfirmed = false;
  try { await api('/v1/auth/logout', 'POST'); } catch { unconfirmed = true; }
  (await cookies()).delete('qx-session');
  redirect(`/${locale(String(form.get('locale')))}/account${unconfirmed ? '?revocation=unconfirmed' : ''}`);
}

// ---------------------------------------------------------------------------------------------
// MISSION A04 — customer identity lifecycle actions.
//
// Every action returns a discriminated result instead of a bare code, because these flows have
// states a single code cannot express: a request that issued a link but could not deliver it, a
// link that is dead versus one that was already used, and a reset that succeeded.
// ---------------------------------------------------------------------------------------------

export type IdentityState =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'ERROR'; readonly code: string }
  | { readonly kind: 'CODE_SENT'; readonly delivered: boolean }
  // A21.06: the authenticated resend reports the server's exact outcome (never a bare "sent").
  | { readonly kind: 'VERIFICATION_RESEND'; readonly view: VerificationResendView }
  | { readonly kind: 'DONE'; readonly message: string };

const workspaceName = (form: FormData) => String(form.get('workspaceName') ?? '').trim();
const invitationToken = (form: FormData) => String(form.get('invitationToken') ?? '').trim();

/** Create an account and open the owner session the API returns. */
export async function registerAction(previous: IdentityState, form: FormData): Promise<IdentityState> {
  let destination: string;
  try {
    const result = sessionSchema.parse(await api('/v1/auth/register', 'POST', {
      email: String(form.get('email') ?? ''), password: String(form.get('password') ?? ''),
      workspaceName: workspaceName(form), locale: locale(String(form.get('locale'))),
      // A21.05: sent only when present; the API's registration policy decides whether it is required.
      ...(invitationToken(form) ? { invitationToken: invitationToken(form) } : {}),
    }, false));
    (await cookies()).set('qx-session', JSON.stringify(result), {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires: new Date(result.expiresAt),
    });
    // Registration and sign-in route identically: new accounts belong in the guided start.
    const lang = locale(String(form.get('locale')));
    destination = await soulAwareDestination(lang, '/' + lang + '/mydash');
  } catch (error) {
    return { kind: 'ERROR', code: error instanceof ApiError ? error.code : 'UNAVAILABLE' };
  }
  redirect(destination);
}

/** Request a verification link for the signed-in account. */
export async function requestVerificationAction(): Promise<IdentityState> {
  // MISSION A21.06 — the session identifies the account; no e-mail is sent from the browser. The API
  // derives the recipient from the authenticated user (POST /v1/identity/verification/resend).
  try {
    return { kind: 'VERIFICATION_RESEND', view: resendViewFromBody(await api('/v1/identity/verification/resend', 'POST')) };
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'UNKNOWN_OUTCOME';
    if (code === 'SESSION_REQUIRED' || code === 'DENIED') return { kind: 'ERROR', code };
    return { kind: 'VERIFICATION_RESEND', view: resendViewFromError(code) };
  }
}

/** Consume a verification token from the e-mailed link. */
export async function confirmVerificationAction(previous: IdentityState, form: FormData): Promise<IdentityState> {
  try {
    await api('/v1/identity/verification/confirm', 'POST', { token: String(form.get('token') ?? '') }, false);
    return { kind: 'DONE', message: 'VERIFIED' };
  } catch (error) {
    return { kind: 'ERROR', code: error instanceof ApiError ? error.code : 'UNAVAILABLE' };
  }
}

/**
 * Request a recovery link. The reply is identical for a known and an unknown address, so this action
 * cannot be turned into an account-existence oracle by watching the result.
 */
export async function requestRecoveryAction(previous: IdentityState, form: FormData): Promise<IdentityState> {
  try {
    const result = tokenRequestSchema.parse(await api('/v1/identity/recovery/request', 'POST', { email: String(form.get('email') ?? '') }, false));
    return { kind: 'CODE_SENT', delivered: result.sent };
  } catch (error) {
    return { kind: 'ERROR', code: error instanceof ApiError ? error.code : 'UNAVAILABLE' };
  }
}

/** Complete recovery with a new password. On success the API has revoked every old session. */
export async function confirmRecoveryAction(previous: IdentityState, form: FormData): Promise<IdentityState> {
  let destination: string;
  try {
    const result = z.object({ reset: z.boolean(), revokedSessions: z.number().int().nonnegative() })
      .parse(await api('/v1/identity/recovery/confirm', 'POST', {
        token: String(form.get('token') ?? ''), password: String(form.get('password') ?? ''),
      }, false));
    if (!result.reset) return { kind: 'ERROR', code: 'INVALID_STATE' };
    destination = `/${locale(String(form.get('locale')))}/account?reset=confirmed`;
  } catch (error) {
    return { kind: 'ERROR', code: error instanceof ApiError ? error.code : 'UNKNOWN_OUTCOME' };
  }
  redirect(destination);
}
