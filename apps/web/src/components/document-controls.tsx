'use client';
import { useCallback, useState, useActionState } from 'react';
import { deleteDocumentAction } from '../lib/document-actions';
import { downloadGrantAction } from '../lib/document-download-action';
import { documentCopy } from '../lib/documents-copy';
import type { Locale } from '../lib/copy';

/** Delete with an explicit confirmation step. Deletion is permanent. */
export function DeleteDocumentForm({ lang, id, label, confirmText }: { lang: Locale; id: string; label: string; confirmText: string }) {
  const t = documentCopy(lang);
  const [state, action, pending] = useActionState(async (_prev: { code: string }, _form: FormData) => {
    if (typeof window !== 'undefined' && !window.confirm(confirmText)) return { code: '' };
    return deleteDocumentAction(id);
  }, { code: '' });
  return (
    <form action={action}>
      <button type="submit" className="button danger" disabled={pending}>{pending ? t.uploading : label}</button>
      {state.code && state.code !== 'OK' ? <p className="feedback error" role="alert"><strong>{state.code}</strong></p> : null}
    </form>
  );
}

/** Mint a short-lived signed download URL on demand (never pre-rendered into the page). */
export function DownloadDocumentLink({ lang, id, label }: { lang: Locale; id: string; label: string }) {
  const t = documentCopy(lang);
  const [pending, setPending] = useState(false);
  const [code, setCode] = useState('');
  const open = useCallback(async () => {
    setPending(true);
    setCode('');
    try {
      const grant = await downloadGrantAction(id);
      if (typeof window !== 'undefined') window.open(grant.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'UNAVAILABLE';
      setCode(message.length <= 40 ? message : 'UNAVAILABLE');
    } finally {
      setPending(false);
    }
  }, [id]);
  return (
    <span>
      <button type="button" className="button secondary" onClick={open} disabled={pending}>{label}</button>
      {code ? <span className="feedback error" role="alert"> ({code})</span> : null}
    </span>
  );
}
