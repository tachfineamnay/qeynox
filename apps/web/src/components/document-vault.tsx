'use client';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { documentCopy } from '../lib/documents-copy';
import { beginUploadAction, completeUploadAction, searchDocumentsAction, type BeginState } from '../lib/document-actions';
import { searchResultSchema, type SearchResult } from '../lib/documents';
import type { Locale } from '../lib/copy';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown', 'text/csv'];
const ACCEPT_ATTR = ACCEPT.join(',') + ',.md';

function guessContentType(file: File): string | null {
  const byType = (file.type ?? '').toLowerCase();
  if (ACCEPT.includes(byType)) return byType;
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'text/markdown';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.txt')) return 'text/plain';
  return null;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function DocumentUpload({ lang }: { lang: Locale }) {
  const t = documentCopy(lang);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [retention, setRetention] = useState('365');
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<BeginState & { stage?: 'idle' | 'hashing' | 'uploading' | 'finalizing' | 'done' }>({ code: '' });
  const [pending, startTransition] = useTransition();

  const submit = useCallback(() => {
    const input = inputRef.current;
    const file = input?.files?.[0];
    if (!file) { setState({ code: 'INVALID_INPUT', error: t.choose }); return; }
    const contentType = guessContentType(file);
    if (!contentType) { setState({ code: 'UNSUPPORTED', error: t.uploadInvalid }); return; }
    if (file.size > MAX_BYTES) { setState({ code: 'INVALID_INPUT', error: t.tooLarge }); return; }
    const trimmedPurpose = purpose.trim();
    if (trimmedPurpose.length < 3) { setState({ code: 'INVALID_INPUT', error: t.purposeRequired }); return; }
    const retentionDays = Number.parseInt(retention, 10);
    if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 3650) { setState({ code: 'INVALID_INPUT', error: t.retentionHint }); return; }
    if (!consent) { setState({ code: 'INVALID_INPUT', error: t.purposeRequired }); return; }

    startTransition(async () => {
      setState({ code: '', stage: 'hashing' });
      const bytes = await file.arrayBuffer();
      const sha256 = await sha256Hex(bytes);
      setState({ code: '', stage: 'uploading' });
      const begun = await beginUploadAction({ name: file.name, contentType, sizeBytes: file.size, sha256, purpose: trimmedPurpose, retentionDays, consent });
      if (begun.code !== 'OK' || !begun.uploadUrl || !begun.documentId) { setState({ ...begun, stage: 'idle' }); return; }
      let put: Response;
      try {
        put = await fetch(begun.uploadUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: bytes });
      } catch {
        setState({ code: 'UNAVAILABLE', error: t.uploadFailed });
        return;
      }
      if (!put.ok) { setState({ code: 'UNAVAILABLE', error: t.uploadFailed + ' (HTTP ' + put.status + ')' }); return; }
      setState({ code: '', stage: 'finalizing' });
      const done = await completeUploadAction(begun.documentId);
      setState({ code: done.code, stage: done.code === 'OK' ? 'done' : 'idle' });
      if (done.code === 'OK') {
        if (inputRef.current) inputRef.current.value = '';
        setFileName(''); setPurpose(''); setConsent(false);
        router.refresh();
      }
    });
  }, [consent, purpose, retention, router, t]);

  const busy = pending || state.stage === 'hashing' || state.stage === 'uploading' || state.stage === 'finalizing';
  return (
    <div className="document-upload">
      <p className="muted">{t.uploadNote}</p>
      <div className="qx-field">
        <label htmlFor="qx-doc-file">{t.file}</label>
        <input ref={inputRef} id="qx-doc-file" type="file" accept={ACCEPT_ATTR} onChange={event => setFileName(event.target.files?.[0]?.name ?? '')} />
      </div>
      <div className="qx-field">
        <label htmlFor="qx-doc-purpose">{t.purpose}</label>
        <textarea id="qx-doc-purpose" value={purpose} onChange={event => setPurpose(event.target.value)} rows={2} placeholder={t.purposeHint} maxLength={300} />
      </div>
      <div className="qx-field">
        <label htmlFor="qx-doc-retention">{t.retention}</label>
        <input id="qx-doc-retention" type="number" min={1} max={3650} value={retention} onChange={event => setRetention(event.target.value)} />
        <p className="muted">{t.retentionHint}</p>
      </div>
      <label className="qx-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /> <span>{t.consentLabel}</span></label>
      <div className="qx-connection-actions">
        <button type="button" onClick={submit} disabled={busy}>{busy ? t.uploading : t.upload}</button>
        {fileName ? <span className="muted">{fileName}</span> : null}
      </div>
      {state.stage === 'done' ? <p className="feedback" role="status"><strong>{t.uploadDone}</strong></p> : null}
      {state.code && state.code !== 'OK' ? <p className="feedback error" role="alert"><strong>{state.error ?? t.uploadFailed}</strong> ({state.code})</p> : null}
    </div>
  );
}

export function DocumentSearch({ lang }: { lang: Locale }) {
  const t = documentCopy(lang);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [code, setCode] = useState('');
  const [pending, startTransition] = useTransition();

  const submit = useCallback(() => {
    const cleaned = query.trim();
    if (cleaned.length < 2) { setCode('INVALID_INPUT'); return; }
    startTransition(async () => {
      const response = await searchDocumentsAction(cleaned, 8);
      setCode(response.code);
      setResult(response.result ? searchResultSchema.parse(response.result) : null);
    });
  }, [query]);

  return (
    <div className="document-search">
      <form onSubmit={event => { event.preventDefault(); submit(); }} className="change-form" style={{ margin: '12px 0' }}>
        <div className="qx-field" style={{ margin: 0 }}>
          <label htmlFor="qx-doc-search" className="qx-sr-only">{t.searchTitle}</label>
          <input id="qx-doc-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t.searchPlaceholder} maxLength={300} />
        </div>
        <div className="export-actions"><button type="submit" className="button secondary" disabled={pending}>{pending ? t.searching : t.search}</button></div>
      </form>
      {code === 'INVALID_INPUT' ? <p className="feedback error" role="alert"><strong>INVALID_INPUT</strong></p> : null}
      {result ? (
        <div>
          <p className="muted">{result.mode === 'HYBRID' ? t.modeHybrid : t.modeFts}{result.embedding === 'NOT_CONFIGURED' ? ' · ' + t.embeddingsOff : ''}</p>
          {result.citations.length === 0 ? <p className="muted">{t.searchEmpty}</p> : (
            <ol className="citation-list">
              {result.citations.map(citation => (
                <li key={citation.citationId}>
                  <strong>{citation.name}</strong>
                  <span className="muted"> · #{citation.ordinal + 1}{citation.page ? ' · p. ' + citation.page : ''} · score {citation.score.toFixed(3)}</span>
                  <p>{citation.snippet}</p>
                  <code>{citation.sha256.slice(0, 16)}…</code>
                </li>
              ))}
            </ol>
          )}
          <p className="muted">{t.citationsNote}</p>
        </div>
      ) : null}
    </div>
  );
}

/** Background refresh for documents that are still PROCESSING (poll every few seconds, bounded). */
export function DocumentsRefresher({ lang, active }: { lang: Locale; active: boolean }) {
  const router = useRouter();
  const t = documentCopy(lang);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 4000);
    const stop = setTimeout(() => clearInterval(timer), 120_000);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, [active, router]);
  return active ? <p className="muted">{t.processing}</p> : null;
}
