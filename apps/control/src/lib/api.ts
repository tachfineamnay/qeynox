import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { z } from 'zod';
import type { PlatformMeView } from './types';

export const CONTROL_COOKIE = 'qx-control-session';
export const sessionSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  expiresAt: z.iso.datetime(),
  userId: z.string().min(4),
});
export type ControlSession = z.infer<typeof sessionSchema>;

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status = 0) { super(code); }
}

export async function readSession(): Promise<ControlSession | null> {
  const raw = (await cookies()).get(CONTROL_COOKIE)?.value;
  try {
    const value = sessionSchema.parse(JSON.parse(raw ?? 'null'));
    return Date.parse(value.expiresAt) > Date.now() ? value : null;
  } catch { return null; }
}

function apiBase(): string {
  const raw = process.env.QEYNOX_PLATFORM_API_URL;
  if (!raw) throw new ApiError('NOT_CONFIGURED');
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiError('NOT_CONFIGURED'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) throw new ApiError('NOT_CONFIGURED');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new ApiError('NOT_CONFIGURED');
  return url.href;
}

export async function api(path: string, method = 'GET', body?: unknown, authenticated = true): Promise<unknown> {
  const base = apiBase();
  const current = authenticated ? await readSession() : null;
  if (authenticated && !current) throw new ApiError('SESSION_REQUIRED', 403);
  try {
    const init: RequestInit = {
      method,
      cache: 'no-store',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(current ? { authorization: 'Bearer ' + current.token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const response = await fetch(new URL(path, base), init);
    const raw = await response.text();
    let value: unknown = null;
    try { value = raw.length ? JSON.parse(raw) : null; } catch { value = null; }
    if (!response.ok) {
      const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(value);
      throw new ApiError(parsed.success ? parsed.data.error.code : 'UNAVAILABLE', response.status);
    }
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(method === 'GET' ? 'UNAVAILABLE' : 'UNKNOWN_OUTCOME');
  }
}

export const meSchema = z.object({
  userId: z.string().min(4),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  sessionExpiresAt: z.string(),
});
export type PlatformMe = z.infer<typeof meSchema>;

export const platformMe = cache(async (): Promise<PlatformMe> => meSchema.parse(await api('/v1/platform/auth/me')));

export async function requirePlatformMe(lang: string): Promise<PlatformMeView> {
  try {
    return await platformMe();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.code === 'SESSION_REQUIRED' || error.code === 'DENIED')) {
      redirect('/' + lang + '/account?expired=1');
    }
    throw error;
  }
}

export function controlPath(lang: string, suffix = ''): string {
  return '/' + lang + (suffix.length ? suffix : '');
}

export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };
export async function tryApi<T>(path: string): Promise<ApiResult<T>> {
  try { return { ok: true, value: (await api(path)) as T }; }
  catch (error) { return { ok: false, code: error instanceof ApiError ? error.code : 'UNAVAILABLE' }; }
}
