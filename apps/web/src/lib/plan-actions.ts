'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { idSchema, planCreateSchema } from '@qeynox/contracts';
import { api, ApiError } from './api';
import { locale } from './copy';
import { planPayloadSchema } from './plan';

export type ActionResult = { code: string };

function failure(error: unknown): ActionResult {
  if (error instanceof ApiError) return { code: error.code };
  if (error instanceof z.ZodError) return { code: 'INVALID_INPUT' };
  return { code: 'INVALID_INPUT' };
}

/** Maps editor step keys to contract dependency indices. Keys never reach the API. */
function drafts(raw: FormDataEntryValue | null) {
  const parsed = planPayloadSchema.parse(JSON.parse(String(raw ?? '[]')));
  const index = new Map(parsed.steps.map((step, position) => [step.key, position]));
  return parsed.steps.map(step => ({
    title: step.title,
    description: step.description,
    capabilityId: step.capabilityId,
    intent: step.intent,
    dependsOnIndices: step.dependsOn
      .map(key => index.get(key))
      .filter((position): position is number => typeof position === 'number' && position >= 0),
  }));
}

/**
 * Creates the first plan revision or records a new revision. The human writing the steps is the
 * validation step; no AI proposal is generated here.
 */
export async function savePlan(previous: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const operationId = idSchema.parse(form.get('operationId'));
    const lang = locale(String(form.get('locale')));
    const expectedVersion = z.coerce.number().int().positive().parse(form.get('version'));
    const payload = planCreateSchema.parse({ expectedVersion, steps: drafts(form.get('steps')) });
    if (form.get('mode') === 'revise') {
      const revisionId = idSchema.parse(form.get('revisionId'));
      const reason = z.string().trim().min(3).max(2000).parse(form.get('reason'));
      await api(`/v1/operations/${operationId}/revisions/${revisionId}/revise`, 'POST', {
        expectedVersion: payload.expectedVersion, reason, steps: payload.steps,
      });
    } else {
      await api(`/v1/operations/${operationId}/plan`, 'POST', payload);
    }
    revalidatePath(`/${lang}/missions/${operationId}`);
    return { code: 'OK' };
  } catch (error) {
    return failure(error);
  }
}

/** Requests execution with the version the operator reviewed and a stable idempotency key. */
export async function startMission(previous: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const operationId = idSchema.parse(form.get('operationId'));
    const lang = locale(String(form.get('locale')));
    const expectedVersion = z.coerce.number().int().positive().parse(form.get('version'));
    const idempotencyKey = z.string().min(8).max(200).parse(form.get('idempotencyKey'));
    await api(`/v1/operations/${operationId}/start`, 'POST', { expectedVersion, idempotencyKey });
    revalidatePath(`/${lang}/missions/${operationId}`);
    return { code: 'OK' };
  } catch (error) {
    return failure(error);
  }
}

/** Records the human decision on a pending approval of this operation. */
export async function decideApproval(previous: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const operationId = idSchema.parse(form.get('operationId'));
    const approvalId = idSchema.parse(form.get('approvalId'));
    const lang = locale(String(form.get('locale')));
    if (form.get('confirm') !== 'on') return { code: 'INVALID_INPUT' };
    const decision = z.enum(['APPROVED', 'REJECTED']).parse(form.get('decision'));
    await api(`/v1/operations/${operationId}/approvals/${approvalId}/decision`, 'POST', { decision });
    revalidatePath(`/${lang}/missions/${operationId}`);
    return { code: 'OK' };
  } catch (error) {
    return failure(error);
  }
}
