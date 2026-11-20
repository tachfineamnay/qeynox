'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from './api';
import { locale } from './copy';

export type ConnectState = { code: string };
export type DisconnectState = { code: string };

const providerSchema = z.string().min(2).max(64).regex(/^[a-z0-9-]+$/);

/** Start the OAuth authorization: server creates the state, then sends the browser to the provider. */
export async function connectAction(previous: ConnectState, form: FormData): Promise<ConnectState> {
  void previous;
  const lang = locale(String(form.get('lang')));
  const provider = providerSchema.safeParse(String(form.get('provider') ?? ''));
  if (!provider.success) return { code: 'INVALID_INPUT' };
  let url: string | null = null;
  try {
    const value = await api('/v1/connections/' + encodeURIComponent(provider.data) + '/authorize', 'POST', {});
    const parsed = z.object({ authorizationUrl: z.string().url(), provider: z.string(), expiresAt: z.string() }).safeParse(value);
    if (!parsed.success) return { code: 'UNAVAILABLE' };
    url = parsed.data.authorizationUrl;
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'UNKNOWN_OUTCOME' };
  }
  redirect(url);
}

/** Manual token repair — the API refreshes through the sealed vault and re-derives capabilities. */
export async function refreshConnectionAction(previous: ConnectState, form: FormData): Promise<ConnectState> {
  void previous;
  const lang = locale(String(form.get('lang')));
  const provider = providerSchema.safeParse(String(form.get('provider') ?? ''));
  if (!provider.success) return { code: 'INVALID_INPUT' };
  try {
    await api('/v1/connections/' + encodeURIComponent(provider.data) + '/refresh', 'POST', {});
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'UNKNOWN_OUTCOME' };
  }
  revalidatePath('/' + lang + '/connections');
  revalidatePath('/admin/' + lang + '/connections');
  return { code: '' };
}

/** Disconnect: provider revocation is best-effort server-side; the sealed local copy is always wiped. */
export async function disconnectAction(previous: DisconnectState, form: FormData): Promise<DisconnectState> {
  void previous;
  const lang = locale(String(form.get('lang')));
  const provider = providerSchema.safeParse(String(form.get('provider') ?? ''));
  if (!provider.success) return { code: 'INVALID_INPUT' };
  try {
    await api('/v1/connections/' + encodeURIComponent(provider.data) + '/disconnect', 'POST', {});
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'UNKNOWN_OUTCOME' };
  }
  revalidatePath('/' + lang + '/connections');
  revalidatePath('/admin/' + lang + '/connections');
  return { code: '' };
}
