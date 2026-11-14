'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, ApiError } from './api';
import { locale, type Locale } from './copy';

function langOf(form: FormData): Locale { return locale(String(form.get('lang') ?? 'en')); }
function detailPath(lang: Locale, id: string): string { return '/admin/' + lang + '/support/' + encodeURIComponent(id); }
function codeOf(error: unknown): string { return error instanceof ApiError ? error.code : 'UNKNOWN_OUTCOME'; }

export async function replySupportAction(form: FormData): Promise<void> {
  const lang = langOf(form);
  const id = String(form.get('conversationId') ?? '');
  const content = String(form.get('content') ?? '').trim();
  let code: string | null = null;
  try {
    await api('/v1/platform/support/conversations/' + encodeURIComponent(id) + '/messages', 'POST', { content });
  } catch (error) { code = codeOf(error); }
  if (code) redirect(detailPath(lang, id) + '?error=' + encodeURIComponent(code));
  revalidatePath(detailPath(lang, id));
  redirect(detailPath(lang, id) + '?done=1');
}

export async function updateSupportStatusAction(form: FormData): Promise<void> {
  const lang = langOf(form);
  const id = String(form.get('conversationId') ?? '');
  const status = String(form.get('status') ?? '');
  let code: string | null = null;
  try {
    await api('/v1/platform/support/conversations/' + encodeURIComponent(id) + '/status', 'POST', { status });
  } catch (error) { code = codeOf(error); }
  if (code) redirect(detailPath(lang, id) + '?error=' + encodeURIComponent(code));
  revalidatePath(detailPath(lang, id));
  redirect(detailPath(lang, id) + '?done=1');
}
