'use server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { api, ApiError } from './api';
import { deletionRequestSchema, profileUpdateSchema, sessionViewSchema } from './workspaces';

export interface AccountState { code: string; message?: string }

const fail = (error: unknown): AccountState => ({ code: error instanceof ApiError ? error.code : 'UNAVAILABLE' });

export async function updateLocaleAction(locale: string): Promise<AccountState> {
  try {
    const input = profileUpdateSchema.parse({ locale });
    await api('/v1/account/profile', 'POST', input);
    return { code: 'OK' };
  } catch (error) { return fail(error); }
}

export async function changePasswordAction(input: { currentPassword: string; nextPassword: string }): Promise<AccountState & { revokedSessions?: number }> {
  try {
    const parsed = z.object({ currentPassword: z.string().min(1).max(256), nextPassword: z.string().min(12).max(256) }).strict().parse(input);
    const result = z.object({ changed: z.boolean(), revokedSessions: z.number().int().nonnegative() })
      .parse(await api('/v1/account/password', 'POST', parsed));
    return { code: 'OK', revokedSessions: result.revokedSessions };
  } catch (error) { return fail(error); }
}

export async function revokeSessionAction(sessionId: string): Promise<AccountState & { current?: boolean }> {
  try {
    const result = z.object({ revoked: z.boolean(), current: z.boolean() })
      .parse(await api('/v1/account/sessions/' + idSchema.parse(sessionId) + '/revoke', 'POST'));
    return { code: 'OK', current: result.current };
  } catch (error) { return fail(error); }
}

export async function revokeOtherSessionsAction(): Promise<AccountState & { revoked?: number }> {
  try {
    const result = z.object({ revoked: z.number().int().nonnegative() })
      .parse(await api('/v1/account/sessions/revoke-others', 'POST'));
    return { code: 'OK', revoked: result.revoked };
  } catch (error) { return fail(error); }
}

export async function requestDeletionAction(reason: string): Promise<AccountState & { outcome?: 'REQUESTED' | 'ALREADY_REQUESTED' }> {
  try {
    const parsed = z.object({ reason: z.string().trim().max(500).optional() }).strict()
      .parse({ reason: reason.trim().length > 0 ? reason.trim() : undefined });
    const result = z.object({ outcome: z.enum(['REQUESTED', 'ALREADY_REQUESTED']), request: deletionRequestSchema })
      .parse(await api('/v1/account/deletion-request', 'POST', parsed));
    return { code: 'OK', outcome: result.outcome };
  } catch (error) { return fail(error); }
}

export async function cancelDeletionAction(): Promise<AccountState> {
  try {
    await api('/v1/account/deletion-request/cancel', 'POST', {});
    return { code: 'OK' };
  } catch (error) { return fail(error); }
}
