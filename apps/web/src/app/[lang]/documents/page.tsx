import { AppShell, Card, EmptyState, Feedback, PageHeader, SectionHeading } from '../../../components/ui';
import { api, ApiError, session, z } from '../../../lib/api';
import { copy, locale } from '../../../lib/copy';
import { documentCopy } from '../../../lib/documents-copy';
import { documentViewSchema, type DocumentView } from '../../../lib/documents';
import { DocumentUpload, DocumentSearch, DocumentsRefresher } from '../../../components/document-vault';
import { DeleteDocumentForm, DownloadDocumentLink } from '../../../components/document-controls';

export const dynamic = 'force-dynamic';

const stateTone: Record<string, string> = {
  AVAILABLE: 'success', PROCESSING: 'info', PENDING_UPLOAD: 'warning', FAILED: 'danger', DELETED: 'neutral',
};
const stateLabel = (t: ReturnType<typeof documentCopy>, state: DocumentView['state']) => ({
  PENDING_UPLOAD: t.statePending, PROCESSING: t.stateProcessing, AVAILABLE: t.stateAvailable, FAILED: t.stateFailed, DELETED: state,
})[state];

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const d = documentCopy(lang);
  const current = await session();
  const configured = Boolean(process.env.QEYNOX_API_URL);
  let docs: DocumentView[] | null = null;
  let failure = '';
  if (current && configured) {
    try {
      docs = z.array(documentViewSchema).parse(await api('/v1/documents'));
    } catch (error) {
      failure = error instanceof ApiError ? error.code : 'UNAVAILABLE';
    }
  }
  const failureText = failure === 'DENIED' ? t.denied : failure === 'NOT_CONFIGURED' ? t.notConfigured : failure === 'SESSION_REQUIRED' ? t.signInRequired : t.error;
  const processing = (docs ?? []).some(doc => doc.state === 'PROCESSING' || doc.state === 'PENDING_UPLOAD');

  return (
    <AppShell lang={lang} active="documents">
      <PageHeader eyebrow={t.eyebrow} title={d.title} description={d.intro} />

      {!configured ? <Feedback title={t.notConfigured} /> : !current ? (
        <Feedback title={t.signInRequired}><a href={'/' + lang + '/account'}>{t.signin} →</a></Feedback>
      ) : failure ? (
        <Card><Feedback error title={failureText}>{failure}</Feedback></Card>
      ) : null}

      {current && configured ? (
        <>
          <Card>
            <SectionHeading title={d.uploadTitle} />
            <DocumentUpload lang={lang} />
          </Card>

          <Card>
            <SectionHeading title={d.searchTitle} />
            <DocumentSearch lang={lang} />
          </Card>

          <Card>
            <SectionHeading title={d.title} />
            <DocumentsRefresher lang={lang} active={processing} />
            {!docs ? null : docs.length === 0 ? (
              <EmptyState title={d.empty} mark="⇪" />
            ) : (
              <ul className="qx-connection-grid">
                {docs.map(doc => (
                  <li key={doc.id} className="qx-connection-card" data-state={doc.state}>
                    <div className="qx-connection-head">
                      <h2 style={{ fontSize: 17, overflowWrap: 'anywhere' }}>{doc.name}</h2>
                      <span className={'badge ' + (stateTone[doc.state] ?? 'neutral')}>{stateLabel(d, doc.state)}</span>
                    </div>
                    {doc.expired ? <Feedback error title={d.expired} /> : null}
                    {doc.state === 'FAILED' && doc.extractionCode ? <Feedback error title={doc.extractionCode} /> : null}
                    <dl className="qx-connection-meta">
                      <div><dt>{d.purpose}</dt><dd>{doc.purpose ?? '—'}</dd></div>
                      <div><dt>SHA-256</dt><dd><code>{doc.sha256.slice(0, 24)}…</code></dd></div>
                      <div><dt>{d.chunks}</dt><dd>{doc.state === 'AVAILABLE' ? doc.chunkCount : '—'}</dd></div>
                      <div><dt>{d.uploaded}</dt><dd><time>{new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(doc.createdAt))}</time></dd></div>
                      <div><dt>{d.retention}</dt><dd>{doc.retentionDays} d · {doc.expiresAt ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(doc.expiresAt)) + ' UTC' : '—'}</dd></div>
                      {doc.attachments > 0 ? <div><dt>Missions</dt><dd>{doc.attachments} {d.attachedTo}</dd></div> : null}
                    </dl>
                    <p className="muted" style={{ fontSize: 13 }}>{d.deleteNote}</p>
                    <div className="qx-connection-actions">
                      {doc.state === 'AVAILABLE' ? <DownloadDocumentLink lang={lang} id={doc.id} label={d.download} /> : null}
                      <DeleteDocumentForm lang={lang} id={doc.id} label={d.delete} confirmText={d.confirmDelete} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </AppShell>
  );
}
