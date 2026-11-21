import 'server-only';
import { z } from 'zod';
import { api, ApiError } from './api';

/**
 * MISSION A21.05 — the registration policy, read from the API (`GET /v1/auth/registration-policy`).
 *
 * The web has NO registration switch of its own: the register page renders only what the API reports
 * here, and the API enforces the very same resolver on `POST /v1/auth/register`. A missing API
 * connection, a failed read or a malformed answer all fail closed: no form is shown.
 */
export const registrationPolicySchema = z.object({
  mode: z.enum(['CLOSED', 'INVITE_ONLY', 'OPEN']),
  acceptingRegistrations: z.boolean(),
  invitationRequired: z.boolean(),
}).refine(policy => policy.acceptingRegistrations === (policy.mode !== 'CLOSED') && policy.invitationRequired === (policy.mode === 'INVITE_ONLY'));
export type RegistrationPolicyView = z.infer<typeof registrationPolicySchema>;

export type RegistrationPolicyRead =
  | { readonly kind: 'OK'; readonly policy: RegistrationPolicyView }
  | { readonly kind: 'NOT_CONFIGURED' }
  | { readonly kind: 'UNAVAILABLE' };

export async function readRegistrationPolicy(): Promise<RegistrationPolicyRead> {
  try {
    const parsed = registrationPolicySchema.safeParse(await api('/v1/auth/registration-policy', 'GET', undefined, false));
    return parsed.success ? { kind: 'OK', policy: parsed.data } : { kind: 'UNAVAILABLE' };
  } catch (error) {
    return error instanceof ApiError && error.code === 'NOT_CONFIGURED' ? { kind: 'NOT_CONFIGURED' } : { kind: 'UNAVAILABLE' };
  }
}

/** Only a well-formed token from the invitation link is pre-filled; anything else is ignored. */
export function invitationFromQuery(value: string | string[] | undefined): string {
  const token = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
}
