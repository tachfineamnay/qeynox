'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createOperationSchema } from '@qeynox/contracts';
import { api, ApiError, operationSchema, sessionSchema } from './api';
import { locale } from './copy';
export type FormState = { code: string };
export async function login(previous: FormState, form: FormData): Promise<FormState> {
  let destination: string;
  try {
    const result = sessionSchema.parse(await api('/v1/auth/login', 'POST', { email: form.get('email'), password: form.get('password') }, false));
    (await cookies()).set('qx-session', JSON.stringify(result), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires: new Date(result.expiresAt) });
    const lang = locale(String(form.get('locale')));
    destination = '/' + lang + '/mydash';
    try {
      const onboarding = await api('/v1/soul/onboarding') as { status?: string };
      if (onboarding.status === 'NOT_STARTED' || onboarding.status === 'IN_PROGRESS' || onboarding.status === 'PAUSED') {
        destination = '/' + lang + '/soul';
      }
    } catch { /* an unavailable onboarding view never blocks access to MyDash */ }
  } catch (error) { return { code: error instanceof ApiError ? error.code : 'UNAVAILABLE' }; }
  redirect(destination);
}
export async function createMission(previous: FormState, form: FormData): Promise<FormState> {
  let destination: string;
  try {
    const goal = String(form.get('goal') ?? '').trim();
    const input = createOperationSchema.safeParse({ goal, title: goal.slice(0, 200), constraints: [] });
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
