'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, ApiError } from './api';
import { locale, type Locale } from './copy';

function langOf(form: FormData): Locale { return locale(String(form.get('locale') ?? 'en')); }
function codeOf(error: unknown): string { return error instanceof ApiError ? error.code : 'UNKNOWN_OUTCOME'; }

export async function openSupportConversation(form: FormData): Promise<void> {
  const lang = langOf(form);
  const message = String(form.get('message') ?? '').trim();
  let destination: string;
  try {
    const detail = await api('/v1/support/conversations', 'POST', { message }) as { conversation?: { id?: string } };
    const id = detail.conversation?.id;
    if (!id) throw new ApiError('UNKNOWN_OUTCOME');
    destination = '/' + lang + '/support/' + encodeURIComponent(id) + '?done=1';
  } catch (error) { redirect('/' + lang + '/support?error=' + encodeURIComponent(codeOf(error))); }
  revalidatePath('/' + lang + '/support');
  redirect(destination);
}

export async function replySupportConversation(form: FormData): Promise<void> {
  const lang = langOf(form);
  const conversationId = String(form.get('conversationId') ?? '');
  const content = String(form.get('content') ?? '').trim();
  try { await api('/v1/support/conversations/' + encodeURIComponent(conversationId) + '/messages', 'POST', { content }); }
  catch (error) { redirect('/' + lang + '/support/' + encodeURIComponent(conversationId) + '?error=' + encodeURIComponent(codeOf(error))); }
  revalidatePath('/' + lang + '/support/' + conversationId);
  redirect('/' + lang + '/support/' + encodeURIComponent(conversationId) + '?done=1');
}
