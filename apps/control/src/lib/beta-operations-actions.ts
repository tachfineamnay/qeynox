'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api, ApiError, platformMe } from './api';
import { locale } from './copy';
import { operationsRecoverySchema } from '../../../../packages/contracts/src/beta-operations';

export interface OperationActionState { status: 'idle' | 'ok' | 'error'; code?: string; token?: string; registrationPath?: string }
const failure = (error: unknown): OperationActionState => ({ status: 'error', code: error instanceof ApiError ? error.code : 'UNKNOWN_OUTCOME' });
function refresh(lang: string, path: string) { revalidatePath('/' + lang + path); revalidatePath('/admin/' + lang + path); }
function expiry(value: FormDataEntryValue | null): string {
  const text = String(value ?? '');
  const date = new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(text) ? text : text + 'Z');
  if (Number.isNaN(date.getTime())) throw new ApiError('INVALID_INPUT');
  return date.toISOString();
}
const invitationInput = z.object({ email: z.email(), betaExpiresAt: z.iso.datetime(), missionQuota: z.coerce.number().int().min(1).max(10000), concurrentLimit: z.coerce.number().int().min(1).max(100), maxProviderSpendMinor: z.coerce.number().int().min(0).max(100000000), currency: z.string().regex(/^[A-Z]{3}$/), reason: z.string().trim().min(10).max(500) });

export async function issueRegistrationAction(_state: OperationActionState, form: FormData): Promise<OperationActionState> {
  try {
    const me = await platformMe();
    if (!me.permissions.includes('ADMINISTRATION')) throw new ApiError('DENIED');
    if (form.get('confirm') !== 'on') throw new ApiError('INVALID_INPUT');
    const parsed = invitationInput.safeParse({ email: String(form.get('email') ?? '').trim(), betaExpiresAt: expiry(form.get('betaExpiresAt')), missionQuota: form.get('missionQuota'), concurrentLimit: form.get('concurrentLimit'), maxProviderSpendMinor: form.get('maxProviderSpendMinor'), currency: String(form.get('currency') ?? '').toUpperCase(), reason: form.get('reason') });
    if (!parsed.success) throw new ApiError('INVALID_INPUT');
    const result = z.object({ invitationToken: z.string(), registrationPath: z.string() }).parse(await api('/v1/platform/registration-invitations', 'POST', parsed.data));
    refresh(locale(String(form.get('lang'))), '/beta/invitations');
    return { status: 'ok', token: result.invitationToken, registrationPath: result.registrationPath };
  } catch (error) { return failure(error); }
}

export async function revokeRegistrationAction(_state: OperationActionState, form: FormData): Promise<OperationActionState> {
  try {
    const me = await platformMe();
    if (!me.permissions.includes('ADMINISTRATION')) throw new ApiError('DENIED');
    if (form.get('confirm') !== 'on') throw new ApiError('INVALID_INPUT');
    const id = z.string().regex(/^[A-Za-z0-9_-]{4,120}$/).parse(form.get('id'));
    const reason = z.string().trim().min(10).max(500).parse(form.get('reason'));
    await api('/v1/platform/registration-invitations/' + id + '/revoke', 'POST', { reason });
    refresh(locale(String(form.get('lang'))), '/beta/invitations');
    return { status: 'ok' };
  } catch (error) { return failure(error); }
}

export async function recoverOperationAction(_state: OperationActionState, form: FormData): Promise<OperationActionState> {
  try {
    const me = await platformMe();
    if (!me.permissions.includes('OPERATIONS')) throw new ApiError('DENIED');
    const parsed = operationsRecoverySchema.safeParse({ action: form.get('action'), id: form.get('id'), workspaceId: form.get('workspaceId'), reason: form.get('reason'), confirm: form.get('confirm') === 'on' });
    if (!parsed.success) throw new ApiError('INVALID_INPUT');
    await api('/v1/platform/operations/recovery', 'POST', parsed.data);
    const lang = locale(String(form.get('lang')));
    refresh(lang, '/operations'); refresh(lang, '/operations/queues');
    const operation = String(form.get('operationId') ?? '');
    if (/^[A-Za-z0-9_-]{4,120}$/.test(operation)) refresh(lang, '/operations/' + operation);
    return { status: 'ok' };
  } catch (error) { return failure(error); }
}
