'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createOperationSchema } from '@qeynox/contracts';
import { api, ApiError, operationSchema } from './api';
import { locale, type Locale } from './copy';

function langOf(form: FormData): Locale { return locale(String(form.get('locale') ?? 'en')); }
function errorCode(error: unknown): string { return error instanceof ApiError ? error.code : 'UNKNOWN_OUTCOME'; }
function back(lang: Locale, code?: string): never {
  revalidatePath('/' + lang + '/soul');
  redirect('/' + lang + '/soul' + (code === undefined ? '' : '?error=' + encodeURIComponent(code)));
}
async function run(lang: Locale, work: () => Promise<unknown>): Promise<never> {
  try { await work(); } catch (error) { back(lang, errorCode(error)); }
  back(lang);
}

export async function startOnboarding(form: FormData): Promise<void> {
  const lang = langOf(form);
  await run(lang, () => api('/v1/soul/onboarding/start', 'POST', { locale: lang }));
}

export async function answerOnboarding(form: FormData): Promise<void> {
  const lang = langOf(form);
  const step = String(form.get('step') ?? '');
  const value = String(form.get('value') ?? '').trim();
  await run(lang, () => api('/v1/soul/onboarding/answer', 'POST', { step, value }));
}

export async function skipOnboarding(form: FormData): Promise<void> {
  const lang = langOf(form);
  const step = String(form.get('step') ?? '');
  await run(lang, () => api('/v1/soul/onboarding/skip', 'POST', { step }));
}

export async function consentOnboarding(form: FormData): Promise<void> {
  const lang = langOf(form);
  const granted = String(form.get('granted') ?? '') === 'true';
  await run(lang, () => api('/v1/soul/onboarding/consent', 'POST', { granted }));
}

export async function pauseOnboarding(form: FormData): Promise<void> {
  const lang = langOf(form);
  await run(lang, () => api('/v1/soul/onboarding/pause', 'POST'));
}

export async function resumeOnboarding(form: FormData): Promise<void> {
  const lang = langOf(form);
  await run(lang, () => api('/v1/soul/onboarding/resume', 'POST'));
}

export async function dismissOnboarding(form: FormData): Promise<void> {
  const lang = langOf(form);
  try { await api('/v1/soul/onboarding/dismiss', 'POST'); } catch (error) { back(lang, errorCode(error)); }
  revalidatePath('/' + lang + '/soul');
  redirect('/' + lang + '/mydash');
}

export async function completeOnboarding(form: FormData): Promise<void> {
  const lang = langOf(form);
  const objective = String(form.get('objective') ?? '').trim();
  try { await api('/v1/soul/onboarding/complete', 'POST', objective.length ? { objective } : {}); }
  catch (error) { back(lang, errorCode(error)); }
  revalidatePath('/' + lang + '/soul');
  redirect('/' + lang + '/mydash');
}

/** Reuses the existing mission creation contract: the first objective becomes a normal mission. */
export async function createMissionFromOnboarding(form: FormData): Promise<void> {
  const lang = langOf(form);
  const objective = String(form.get('objective') ?? '').trim();
  let destination: string;
  try {
    await api('/v1/soul/onboarding/complete', 'POST', { objective });
    const input = createOperationSchema.safeParse({ goal: objective, title: objective.slice(0, 200), constraints: [] });
    if (!input.success) back(lang, 'INVALID_INPUT');
    const operation = operationSchema.parse(await api('/v1/operations', 'POST', input.data));
    destination = '/' + lang + '/missions/' + encodeURIComponent(operation.id);
  } catch (error) { return back(lang, errorCode(error)); }
  revalidatePath('/' + lang + '/soul');
  redirect(destination);
}

export async function saveContextFact(form: FormData): Promise<void> {
  const lang = langOf(form);
  const key = String(form.get('key') ?? '').trim();
  const consentId = String(form.get('consentId') ?? '');
  const raw = String(form.get('value') ?? '');
  let value: unknown = raw;
  try { value = JSON.parse(raw) as unknown; } catch { value = raw; }
  await run(lang, () => api('/v1/soul/context/facts', 'POST', { key, value, consentId }));
}

export async function deleteContextFact(form: FormData): Promise<void> {
  const lang = langOf(form);
  const factId = String(form.get('factId') ?? '');
  await run(lang, () => api('/v1/soul/context/facts/' + encodeURIComponent(factId), 'DELETE'));
}

export async function deleteAllContext(form: FormData): Promise<void> {
  const lang = langOf(form);
  await run(lang, () => api('/v1/soul/context', 'DELETE'));
}

export async function revokeContextConsent(form: FormData): Promise<void> {
  const lang = langOf(form);
  const consentId = String(form.get('consentId') ?? '');
  await run(lang, () => api('/v1/soul/consents/' + encodeURIComponent(consentId) + '/revoke', 'POST'));
}
