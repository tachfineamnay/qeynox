'use server';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { api, ApiError, CONTROL_COOKIE, controlPath, sessionSchema } from './api';
import { locale } from './copy';
import type { ConfigurationActionState, ConfigurationApplyResultView, InviteState } from './types';

const emailSchema = z.email();
const reasonSchema = z.string().trim().min(10).max(500);
const roleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(256) });

function langOf(form: FormData): 'en' | 'fr' { return locale(String(form.get('lang') ?? 'en')); }
function localePath(lang: 'en' | 'fr', suffix: string): string { return controlPath(lang, suffix); }
function withError(lang: 'en' | 'fr', suffix: string, code: string): never {
  const separator = suffix.includes('?') ? '&' : '?';
  redirect(localePath(lang, suffix) + separator + 'error=' + encodeURIComponent(code));
}
function withDone(lang: 'en' | 'fr', suffix: string): never {
  const separator = suffix.includes('?') ? '&' : '?';
  redirect(localePath(lang, suffix) + separator + 'done=1');
}
function errorCode(error: unknown): string { return error instanceof ApiError ? error.code : 'UNKNOWN_OUTCOME'; }
function revalidate(lang: 'en' | 'fr', suffix: string): void {
  // Revalidate both the App Router path and the public (basePath-prefixed) cache key.
  revalidatePath(controlPath(lang, suffix));
  revalidatePath('/admin' + controlPath(lang, suffix));
}

export async function loginAction(form: FormData): Promise<void> {
  const lang = langOf(form);
  const parsed = loginSchema.safeParse({ email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') });
  if (!parsed.success) withError(lang, '/account', 'INVALID_INPUT');
  let session: { token: string; expiresAt: string; userId: string };
  try {
    const result = z.object({ token: z.string(), expiresAt: z.string(), userId: z.string() }).parse(
      await api('/v1/platform/auth/login', 'POST', parsed.data, false),
    );
    session = result;
  } catch (error) { withError(lang, '/account', errorCode(error)); }
  const value = sessionSchema.parse(session);
  (await cookies()).set(CONTROL_COOKIE, JSON.stringify(value), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/admin',
    expires: new Date(value.expiresAt),
  });
  redirect(localePath(lang, ''));
}

export async function logoutAction(form: FormData): Promise<void> {
  const lang = langOf(form);
  let revoked = true;
  try { await api('/v1/platform/auth/logout', 'POST'); } catch { revoked = false; }
  (await cookies()).set(CONTROL_COOKIE, '', { path: '/admin', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 0 });
  redirect(localePath(lang, revoked ? '/account?signout=1' : '/account?error=UNKNOWN_OUTCOME'));
}


const platformUserIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{4,120}$/);
const platformRoleSchema = z.enum(['PLATFORM_ADMIN', 'SUPPORT', 'OPERATIONS', 'AUDITOR']);

export async function assignPlatformRoleAction(form: FormData): Promise<void> {
  const lang = langOf(form);
  const userId = platformUserIdSchema.safeParse(String(form.get('userId') ?? ''));
  const role = platformRoleSchema.safeParse(String(form.get('role') ?? ''));
  const reason = reasonSchema.safeParse(String(form.get('reason') ?? ''));
  if (!userId.success || !role.success || !reason.success) withError(lang, '/admins', 'INVALID_INPUT');
  try {
    await api('/v1/platform/admins/' + encodeURIComponent(userId.data) + '/assign', 'POST', { role: role.data, reason: reason.data });
  } catch (error) { withError(lang, '/admins', errorCode(error)); }
  revalidate(lang, '/admins');
  withDone(lang, '/admins');
}

export async function revokePlatformRoleAction(form: FormData): Promise<void> {
  const lang = langOf(form);
  const userId = platformUserIdSchema.safeParse(String(form.get('userId') ?? ''));
  const role = platformRoleSchema.safeParse(String(form.get('role') ?? ''));
  const reason = reasonSchema.safeParse(String(form.get('reason') ?? ''));
  if (!userId.success || !role.success || !reason.success) withError(lang, '/admins', 'INVALID_INPUT');
  try {
    await api('/v1/platform/admins/' + encodeURIComponent(userId.data) + '/revoke', 'POST', { role: role.data, reason: reason.data });
  } catch (error) { withError(lang, '/admins', errorCode(error)); }
  revalidate(lang, '/admins');
  withDone(lang, '/admins');
}

export async function suspendUserAction(form: FormData): Promise<void> {
  const lang = langOf(form);
  const userId = String(form.get('userId') ?? '');
  const reason = reasonSchema.safeParse(String(form.get('reason') ?? ''));
  if (!reason.success) withError(lang, '/users/' + encodeURIComponent(userId), 'INVALID_INPUT');
  try { await api('/v1/platform/users/' + encodeURIComponent(userId) + '/suspend', 'POST', { reason: reason.data }); }
  catch (error) { withError(lang, '/users/' + encodeURIComponent(userId), errorCode(error)); }
  revalidate(lang, '/users/' + userId);
  withDone(lang, '/users/' + encodeURIComponent(userId));
}

export async function reactivateUserAction(form: FormData): Promise<void> {
  const lang = langOf(form);
  const userId = String(form.get('userId') ?? '');
  const reason = reasonSchema.safeParse(String(form.get('reason') ?? ''));
  if (!reason.success) withError(lang, '/users/' + encodeURIComponent(userId), 'INVALID_INPUT');
  try { await api('/v1/platform/users/' + encodeURIComponent(userId) + '/reactivate', 'POST', { reason: reason.data }); }
  catch (error) { withError(lang, '/users/' + encodeURIComponent(userId), errorCode(error)); }
  revalidate(lang, '/users/' + userId);
  withDone(lang, '/users/' + encodeURIComponent(userId));
}

export async function revokeUserSessionsAction(form: FormData): Promise<void> {
  const lang = langOf(form);
  const userId = String(form.get('userId') ?? '');
  const reason = reasonSchema.safeParse(String(form.get('reason') ?? ''));
  if (!reason.success) withError(lang, '/users/' + encodeURIComponent(userId), 'INVALID_INPUT');
  try { await api('/v1/platform/users/' + encodeURIComponent(userId) + '/sessions/revoke', 'POST', { reason: reason.data }); }
  catch (error) { withError(lang, '/users/' + encodeURIComponent(userId), errorCode(error)); }
  revalidate(lang, '/users/' + userId);
  withDone(lang, '/users/' + encodeURIComponent(userId));
}

export async function changeRoleAction(form: FormData): Promise<void> {
  const lang = langOf(form);
  const workspaceId = String(form.get('workspaceId') ?? '');
  const membershipId = String(form.get('membershipId') ?? '');
  const suffix = '/organizations/' + encodeURIComponent(workspaceId);
  const role = roleSchema.safeParse(String(form.get('role') ?? ''));
  const reason = reasonSchema.safeParse(String(form.get('reason') ?? ''));
  if (!role.success || !reason.success) withError(lang, suffix, 'INVALID_INPUT');
  try {
    await api('/v1/platform/organizations/' + encodeURIComponent(workspaceId) + '/members/' + encodeURIComponent(membershipId) + '/role', 'POST', { role: role.data, reason: reason.data });
  } catch (error) { withError(lang, suffix, errorCode(error)); }
  revalidate(lang, suffix);
  withDone(lang, suffix);
}

export async function revokeMembershipAction(form: FormData): Promise<void> {
  const lang = langOf(form);
  const workspaceId = String(form.get('workspaceId') ?? '');
  const membershipId = String(form.get('membershipId') ?? '');
  const suffix = '/organizations/' + encodeURIComponent(workspaceId);
  const reason = reasonSchema.safeParse(String(form.get('reason') ?? ''));
  if (!reason.success) withError(lang, suffix, 'INVALID_INPUT');
  try {
    await api('/v1/platform/organizations/' + encodeURIComponent(workspaceId) + '/members/' + encodeURIComponent(membershipId) + '/revoke', 'POST', { reason: reason.data });
  } catch (error) { withError(lang, suffix, errorCode(error)); }
  revalidate(lang, suffix);
  withDone(lang, suffix);
}

export async function inviteMemberAction(previous: InviteState, form: FormData): Promise<InviteState> {
  void previous;
  const lang = langOf(form);
  const workspaceId = String(form.get('workspaceId') ?? '');
  const email = emailSchema.safeParse(String(form.get('email') ?? ''));
  const role = roleSchema.safeParse(String(form.get('role') ?? ''));
  const reason = reasonSchema.safeParse(String(form.get('reason') ?? ''));
  if (!email.success || !role.success || !reason.success) return { status: 'error', code: 'INVALID_INPUT' };
  try {
    const result = await api('/v1/platform/organizations/' + encodeURIComponent(workspaceId) + '/invitations', 'POST', { email: email.data, role: role.data, reason: reason.data }) as {
      invitationToken?: string; invitationExpiresAt?: string;
      delivery?: { email?: string; reason?: string };
    };
    revalidate(lang, '/organizations/' + workspaceId);
    return {
      status: 'ok',
      token: result.invitationToken,
      expiresAt: result.invitationExpiresAt,
      workspaceId,
      delivery: { email: result.delivery?.email ?? 'BLOCKED', reason: result.delivery?.reason ?? 'EMAIL_PROVIDER_NOT_CONFIGURED' },
    };
  } catch (error) {
    return { status: 'error', code: errorCode(error) };
  }
}

const configurationWorkspaceSchema = z.string().trim().min(4).max(120).regex(/^[A-Za-z0-9_-]+$/, 'Invalid workspace id');
const configurationIdempotencySchema = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9_.:-]+$/, 'Invalid idempotency key');
const configurationEntriesSchema = z.array(z.record(z.string(), z.unknown())).min(1).max(64);

/**
 * Preview or apply an operator configuration bundle from the platform console.
 *
 * The platform API re-validates everything (strict entry contract, operator allowlist, ACTIVE
 * membership in the target workspace) and audits the call. Applying additionally requires the
 * explicit confirmation checkbox; the idempotency key makes a retry safe.
 */
export async function configureAction(previous: ConfigurationActionState, form: FormData): Promise<ConfigurationActionState> {
  void previous;
  const lang = langOf(form);
  const mode = String(form.get('mode') ?? 'preview');
  if (mode !== 'preview' && mode !== 'apply') return { status: 'error', code: 'INVALID_INPUT' };
  const workspaceId = configurationWorkspaceSchema.safeParse(String(form.get('workspaceId') ?? ''));
  const reason = reasonSchema.safeParse(String(form.get('reason') ?? ''));
  const idempotencyKey = configurationIdempotencySchema.safeParse(String(form.get('idempotencyKey') ?? ''));
  let entriesJson: unknown = null;
  try { entriesJson = JSON.parse(String(form.get('entries') ?? '')); } catch { entriesJson = null; }
  const entries = configurationEntriesSchema.safeParse(entriesJson);
  if (!workspaceId.success || !reason.success || !idempotencyKey.success || !entries.success) {
    return { status: 'error', code: 'INVALID_INPUT', mode };
  }
  if (mode === 'apply' && String(form.get('confirm') ?? '') !== 'on') {
    return { status: 'error', code: 'CONFIRMATION_REQUIRED', mode };
  }
  const path = mode === 'preview' ? '/v1/platform/configuration/preview' : '/v1/platform/configuration/apply';
  try {
    const result = await api(path, 'POST', {
      workspaceId: workspaceId.data,
      reason: reason.data,
      idempotencyKey: idempotencyKey.data,
      entries: entries.data,
    }) as ConfigurationApplyResultView;
    revalidate(lang, '/configuration');
    return { status: 'done', mode, result };
  } catch (error) {
    return { status: 'error', code: errorCode(error), mode };
  }
}

export type ServiceValidationState = { status: 'idle' | 'done' | 'error'; code?: string; report?: import('./types').PlatformServiceValidationView };

const validateServiceSchema = z.object({
  workspaceId: configurationWorkspaceSchema,
  capabilityId: z.string().trim().min(2).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
  offerId: z.string().trim().min(2).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
  expectedProvider: z.enum(['world-bank', 'brave-search']),
});

/**
 * Read-only validation of one service definition against the live configuration. The platform API
 * re-checks authorization and audits the call; nothing is created, modified or activated. The
 * iteration basis comes from the ACTIVE business profile and is reported, never invented.
 */
export async function validateServiceAction(previous: ServiceValidationState, form: FormData): Promise<ServiceValidationState> {
  void previous;
  const parsed = validateServiceSchema.safeParse({
    workspaceId: String(form.get('workspaceId') ?? ''),
    capabilityId: String(form.get('capabilityId') ?? ''),
    offerId: String(form.get('offerId') ?? ''),
    expectedProvider: String(form.get('expectedProvider') ?? ''),
  });
  if (!parsed.success) return { status: 'error', code: 'INVALID_INPUT' };
  try {
    const report = await api('/v1/platform/configuration/validate-service', 'POST', parsed.data) as import('./types').PlatformServiceValidationView;
    return { status: 'done', report };
  } catch (error) {
    return { status: 'error', code: errorCode(error) };
  }
}
