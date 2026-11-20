'use client';
import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { attachDocumentAction, detachDocumentAction } from '../lib/document-actions';
import { missionCopy } from '../lib/mission-copy';
import type { Locale } from '../lib/copy';

export interface MissionDocItem {
  id: string;
  name: string;
  state: string;
  sizeBytes: number;
}

/** Attach/detach uploaded documents to this mission. Server state is authoritative; refresh re-reads. */
export function MissionDocumentControls({ lang, operationId, attached, available }: {
  lang: Locale;
  operationId: string;
  attached: readonly MissionDocItem[];
  available: readonly MissionDocItem[];
}) {
  const m = missionCopy(lang);
  const router = useRouter();
  const [selected, setSelected] = useState('');
  const [pending, startTransition] = useTransition();
  const [code, setCode] = useState('');
  const attachable = available.filter(doc => doc.state === 'AVAILABLE' && !attached.some(item => item.id === doc.id));

  const attach = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const target = selected;
    setCode('');
    startTransition(async () => {
      const result = await attachDocumentAction(operationId, target);
      setCode(result.code === 'OK' ? '' : result.code);
      if (result.code === 'OK') { setSelected(''); router.refresh(); }
    });
  }, [operationId, router, selected]);

  const detach = useCallback((documentId: string) => {
    setCode('');
    startTransition(async () => {
      const result = await detachDocumentAction(operationId, documentId);
      setCode(result.code === 'OK' ? '' : result.code);
      if (result.code === 'OK') router.refresh();
    });
  }, [operationId, router]);

  return (
    <div>
      <p className="muted">{m.missionDocumentsNote}</p>
      <form onSubmit={attach} className="change-form" style={{ margin: '12px 0', maxWidth: 480 }}>
        <div className="qx-field" style={{ margin: 0 }}>
          <label htmlFor="qx-attach-doc">{m.attachDocument}</label>
          <select id="qx-attach-doc" value={selected} onChange={event => setSelected(event.target.value)} disabled={pending || attachable.length === 0}>
            <option value="">{m.attachSelect}</option>
            {attachable.map(doc => <option key={doc.id} value={doc.id}>{doc.name}</option>)}
          </select>
        </div>
        <div className="export-actions">
          <button type="submit" className="button secondary" disabled={pending || !selected}>{pending ? m.busy : m.attachDocument}</button>
        </div>
      </form>
      {code ? <p className="feedback error" role="alert"><strong>{code}</strong></p> : null}
      {attached.length === 0 ? (
        <p className="muted" style={{ marginTop: 8 }}>{m.noAttached} <a href={'/' + lang + '/documents'}>{m.openDocuments} →</a></p>
      ) : (
        <ul className="document-list">
          {attached.map(doc => (
            <li key={doc.id}>
              <span className="mission-title">{doc.name}</span>
              <span className="muted"> · {(doc.sizeBytes / 1024).toFixed(0)} {lang === 'fr' ? 'Ko' : 'KB'}</span>
              <button type="button" className="button secondary" onClick={() => detach(doc.id)} disabled={pending} style={{ minHeight: 44 }}>{m.detach}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
