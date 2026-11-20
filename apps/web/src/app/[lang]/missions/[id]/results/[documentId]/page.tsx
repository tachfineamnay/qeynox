import Link from 'next/link';
import { idSchema } from '@qeynox/contracts';
import { AppShell, Card, Feedback, PageHeader, SectionHeading, StatusBadge } from '../../../../../../components/ui';
import { AtlasResult, type AtlasDocument } from '../../../../../../components/atlas';
import { DeliverForm } from '../../../../../../components/mission-flow';
import { ExportForm } from '../../../../../../components/mission-controls';
import { copy, locale } from '../../../../../../lib/copy';
import { missionCopy } from '../../../../../../lib/mission-copy';
import { read, detailSchema, documentSchema } from '../../../../../../lib/mission';
import { planViewSchema } from '../../../../../../lib/plan';

/**
 * MISSION A07 — Atlas result reader.
 *
 * Same route and same document contract as before; the presentation is now outcome-first and the
 * finding classes are separated structurally. Anything the API cannot prove is shown as blocked
 * rather than as an empty state that looks like "no findings".
 */
export default async function Page({ params }: { params: Promise<{ lang: string; id: string; documentId: string }> }) {
  const p = await params;
  const lang = locale(p.lang);
  const t = copy[lang];
  const m = missionCopy(lang);
  const f = m.flow;

  const id = idSchema.safeParse(p.id);
  const docId = idSchema.safeParse(p.documentId);
  if (!id.success || !docId.success) {
    return <AppShell lang={lang} active="missions"><PageHeader eyebrow={t.missions} title={m.unavailable} /><Feedback title={`${m.unavailable} (INVALID_INPUT)`} error /></AppShell>;
  }

  const result = await read(`/v1/operations/${id.data}/documents/${docId.data}`, documentSchema);
  const doc = result.data;
  // A document that belongs to another operation is refused rather than rendered under this URL.
  if (!doc || doc.operationId !== id.data || doc.id !== docId.data) {
    return <AppShell lang={lang} active="missions"><PageHeader eyebrow={t.missions} title={m.unavailable} /><Feedback title={`${m.unavailable} (${result.code ?? 'INVALID_RESPONSE'})`} error /></AppShell>;
  }

  // The reader must still work when the operation/plan cannot be read: only delivery depends on them.
  const [operation, plan] = await Promise.all([
    read(`/v1/operations/${id.data}`, detailSchema),
    read(`/v1/operations/${id.data}/plan`, planViewSchema),
  ]);
  const approvedReview = (plan.data?.approvals ?? []).find(approval => approval.purpose === 'RESULT_REVIEW' && approval.status === 'APPROVED' && !approval.stale);

  const atlas: AtlasDocument = {
    id: doc.id, operationId: doc.operationId, version: doc.version, title: doc.title, objective: doc.objective,
    status: doc.status, scope: doc.scope, findings: doc.findings, nextActions: doc.nextActions,
    limitations: doc.limitations, unresolved: doc.unresolved, citations: doc.citations, createdAt: doc.createdAt,
  };

  const delivery = (
    <Card>
      <SectionHeading title={f.deliveryTitle} />
      {doc.status === 'DELIVERABLE'
        ? <p className="qx-ready">✓ {f.deliveredNote}</p>
        : doc.status !== 'READY_FOR_REVIEW'
          ? <p className="muted">{f.deliverBlockedDocument}</p>
          : operation.data?.status !== 'WAITING_APPROVAL'
            ? <p className="muted">{f.deliverBlockedApproval}</p>
            : approvedReview
              ? <DeliverForm lang={lang} operationId={id.data} documentId={doc.id} approvalId={approvedReview.id} />
              : <p className="muted">{f.deliverBlockedApproval}</p>}
    </Card>
  );

  const exporters = (
    <div className="export-actions">
      {(['pdf', 'html', 'json'] as const).map(format => (
        <ExportForm key={format} lang={lang} operationId={id.data} documentId={doc.id} format={format} />
      ))}
    </div>
  );

  return (
    <AppShell lang={lang} active="missions">
      <Link href={`/${lang}/missions/${id.data}`}>← {t.detail}</Link>
      <AtlasResult
        doc={atlas}
        lang={lang}
        actions={delivery}
        exportsSlot={<><p className="muted">{m.exportNote}</p>{exporters}</>}
      />
      <Card>
        <SectionHeading title={m.version} note={<StatusBadge status={doc.status} lang={lang} />} />
        <p className="muted">{lang === 'fr' ? 'Généré le' : 'Generated on'}: <time dateTime={doc.createdAt}>{doc.createdAt}</time></p>
      </Card>
    </AppShell>
  );
}
