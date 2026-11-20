'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { idSchema, planCreateSchema } from '@qeynox/contracts';
import { api, ApiError } from './api';
import { locale } from './copy';
import { planPayloadSchema } from './plan';

/**
 * `checkoutUrl` is present only when a provider actually returned a hosted page. It is a redirect
 * target, never evidence that money moved.
 */
export type ActionResult = { code: string; checkoutUrl?: string };

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

/** Requests a real quote for the current plan revision from a configured active offer. */
export async function requestQuote(previous: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const operationId = idSchema.parse(form.get('operationId'));
    const offerId = idSchema.parse(form.get('offerId'));
    const revisionId = idSchema.parse(form.get('revisionId'));
    const lang = locale(String(form.get('locale')));
    await api(`/v1/operations/${operationId}/commercial/quote`, 'POST', { offerId, revisionId });
    revalidatePath(`/${lang}/missions/${operationId}`);
    return { code: 'OK' };
  } catch (error) {
    return failure(error);
  }
}

/** Accepts a stored quote. The server decides whether the order is authorized or requires payment. */
export async function acceptQuote(previous: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const operationId = idSchema.parse(form.get('operationId'));
    const quoteId = idSchema.parse(form.get('quoteId'));
    const idempotencyKey = z.string().min(8).max(200).parse(form.get('idempotencyKey'));
    const lang = locale(String(form.get('locale')));
    await api(`/v1/operations/${operationId}/commercial/quotes/${quoteId}/accept`, 'POST', { idempotencyKey });
    revalidatePath(`/${lang}/missions/${operationId}`);
    return { code: 'OK' };
  } catch (error) {
    return failure(error);
  }
}

/**
 * MISSION A08 — starts (or safely resumes) checkout for an accepted paid order.
 *
 * The idempotency key is generated once by the form and kept across retries, so a double submit or a
 * refresh cannot create a second payment. The success/cancel URLs point back at this mission page; they
 * are navigation targets, never proof — the server treats the return page as a read.
 */
export async function startCheckout(previous: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const operationId = idSchema.parse(form.get('operationId'));
    const orderId = idSchema.parse(form.get('orderId'));
    const idempotencyKey = z.string().min(8).max(200).parse(form.get('idempotencyKey'));
    const lang = locale(String(form.get('locale')));
    const origin = z.string().url().parse(form.get('origin'));
    const result = z.object({ checkoutUrl: z.string().nullable(), reused: z.boolean() })
      .parse(await api(`/v1/operations/${operationId}/payments/checkout`, 'POST', {
        orderId, idempotencyKey,
        successUrl: origin + '/' + lang + '/missions/' + operationId + '?payment=returned',
        cancelUrl: origin + '/' + lang + '/missions/' + operationId + '?payment=cancelled',
        expiresInSeconds: 1800,
      }));
    revalidatePath(`/${lang}/missions/${operationId}`);
    // The URL is returned to the page, which redirects. A missing URL is a real failure, not a success.
    if (!result.checkoutUrl) return { code: 'PAYMENT_NOT_CONFIGURED' };
    return { code: 'OK', checkoutUrl: result.checkoutUrl };
  } catch (error) {
    return failure(error);
  }
}

/** Records a human review decision and re-assembles the review document when review is open. */
export async function reviewClaim(previous: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const operationId = idSchema.parse(form.get('operationId'));
    const claimId = idSchema.parse(form.get('claimId'));
    const lang = locale(String(form.get('locale')));
    if (form.get('confirm') !== 'on') return { code: 'INVALID_INPUT' };
    const reviewerDecision = z.enum(['SUPPORTED', 'DISPROVEN', 'CONFLICTING']).parse(form.get('decision'));
    const reason = z.string().trim().min(5).max(2000).parse(form.get('reason'));
    await api(`/v1/operations/${operationId}/claims/${claimId}/assess-active`, 'POST', { reviewerDecision, reason });
    try {
      await api(`/v1/operations/${operationId}/documents/assemble`, 'POST');
    } catch (error) {
      // Re-assembly is only possible while result review is open; the review itself is recorded.
      if (!(error instanceof ApiError) || error.code !== 'INVALID_STATE') throw error;
    }
    revalidatePath(`/${lang}/missions/${operationId}`);
    return { code: 'OK' };
  } catch (error) {
    return failure(error);
  }
}

/** Re-assembles the review version from the current claim assessments. */
export async function reassembleDocument(previous: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const operationId = idSchema.parse(form.get('operationId'));
    const lang = locale(String(form.get('locale')));
    await api(`/v1/operations/${operationId}/documents/assemble`, 'POST');
    revalidatePath(`/${lang}/missions/${operationId}`);
    return { code: 'OK' };
  } catch (error) {
    return failure(error);
  }
}

/** Delivers the reviewed document for an approved RESULT_REVIEW approval. */
export async function deliverResult(previous: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const operationId = idSchema.parse(form.get('operationId'));
    const documentId = idSchema.parse(form.get('documentId'));
    const approvalId = idSchema.parse(form.get('approvalId'));
    const lang = locale(String(form.get('locale')));
    if (form.get('confirm') !== 'on') return { code: 'INVALID_INPUT' };
    await api(`/v1/operations/${operationId}/documents/${documentId}/deliver`, 'POST', { approvalId });
    revalidatePath(`/${lang}/missions/${operationId}`);
    revalidatePath(`/${lang}/missions/${operationId}/results/${documentId}`);
    return { code: 'OK' };
  } catch (error) {
    return failure(error);
  }
}
