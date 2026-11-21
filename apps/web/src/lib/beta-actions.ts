'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api, ApiError } from './api';
import { locale } from './copy';

/**
 * MISSION A21.04 — redeems a beta invitation for the session's workspace (A21.02
 * `POST /v1/workspaces/current/beta-access/activate`). The API enforces OWNER/ADMIN, single use,
 * expiry, tenant binding and no self-activation; this action only validates the token's shape.
 */
const tokenSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/);

export async function activateBeta(_previous: { code: string }, form: FormData): Promise<{ code: string }> {
  const lang = locale(String(form.get('locale')));
  const token = tokenSchema.safeParse(form.get('token'));
  if (!token.success) return { code: 'INVALID_INPUT' };
  try {
    await api('/v1/workspaces/current/beta-access/activate', 'POST', { token: token.data });
    revalidatePath(`/${lang}/mydash`);
    return { code: 'OK' };
  } catch (error) {
    return { code: error instanceof ApiError ? error.code : 'UNAVAILABLE' };
  }
}
