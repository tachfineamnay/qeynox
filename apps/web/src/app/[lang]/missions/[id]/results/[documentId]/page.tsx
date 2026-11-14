import Link from 'next/link';
import { idSchema } from '@qeynox/contracts';
import { AppShell, Card, Feedback, SectionHeading, StatusBadge } from '../../../../../../components/ui';
import { DeliverForm } from '../../../../../../components/mission-flow';
import { ExportForm } from '../../../../../../components/mission-controls';
import { copy, locale } from '../../../../../../lib/copy';
import { missionCopy } from '../../../../../../lib/mission-copy';
import { read, detailSchema, documentSchema, safeUrl } from '../../../../../../lib/mission';
import { planViewSchema } from '../../../../../../lib/plan';

export default async function Page({ params }: { params: Promise<{ lang: string; id: string; documentId: string }> }) {
  const p = await params;
  const lang = locale(p.lang);
  const t = copy[lang];
  const m = missionCopy(lang);
  const f = m.flow;
  const id = idSchema.safeParse(p.id);
  const docId = idSchema.safeParse(p.documentId);
  const result = id.success && docId.success ? await read(`/v1/operations/${id.data}/documents/${docId.data}`, documentSchema) : { code: 'INVALID_INPUT' };
  const doc = result.data;
  if (!doc || doc.operationId !== p.id || doc.id !== p.documentId) {
    return <AppShell lang={lang} active="missions"><Feedback title={`${m.unavailable} (${result.code ?? 'INVALID_RESPONSE'})`} error /></AppShell>;
  }
  const [operation, plan] = await Promise.all([
    read(`/v1/operations/${p.id}`, detailSchema),
    read(`/v1/operations/${p.id}/plan`, planViewSchema),
  ]);
  const approvedReview = (plan.data?.approvals ?? []).find(approval => approval.purpose === 'RESULT_REVIEW' && approval.status === 'APPROVED' && !approval.stale);
  const citations = (items: typeof doc.citations) => items.length ? (
    <ul className="citation-list">
      {items.map((c, i) => (
        <li key={`${c.sourceId}-${i}`}>
          <strong>{c.provider}</strong> · {safeUrl(c.uri) ? <a href={safeUrl(c.uri)} target="_blank" rel="noopener noreferrer">{c.uri}</a> : <span>{m.noSource}</span>}
          <p className="muted">{m.retrieved}: {c.retrievedAt} · {c.publishedAt ? `${m.published}: ${c.publishedAt}` : m.unknownDate}</p>
          {c.fingerprint && <details><summary>SHA-256</summary><code>{c.fingerprint}</code></details>}
        </li>
      ))}
    </ul>
  ) : <p>{m.noSource}</p>;
  return (
    <AppShell lang={lang} active="missions">
      <Link href={`/${lang}/missions/${p.id}`}>← {t.detail}</Link>
      <header className="page-intro"><h1>{doc.title}</h1><p>{doc.objective}</p><p>{m.version} {doc.version}</p><StatusBadge status={doc.status} lang={lang} /></header>
      <Card>
        <h2>{m.scope}</h2><ul>{doc.scope.map((text, i) => <li key={i}>{text}</li>)}</ul>
        <h2>{m.findings}</h2>
        {doc.findings.length === 0 && <p>{m.empty}</p>}
        {doc.findings.map((finding, i) => (
          <article className="finding" key={`${finding.claimId}-${i}`}>
            <h3>{finding.statement}</h3>
            <StatusBadge status={finding.status} lang={lang} />
            <ul>{finding.limitations.map((text, j) => <li key={j}>{text}</li>)}</ul>
            {citations(finding.citations)}
          </article>
        ))}
      </Card>
      <Card>
        <h2>{m.limits}</h2>
        {doc.limitations.length ? <ul>{doc.limitations.map((text, i) => <li key={i}>{text}</li>)}</ul> : <p className="muted">{m.none}</p>}
        <h3>{m.unresolved}</h3>
        {doc.unresolved.length ? <ul>{doc.unresolved.map((text, i) => <li key={i}><code>{text}</code></li>)}</ul> : <p className="muted">{m.none}</p>}
        <h2>{m.next}</h2>
        {doc.nextActions.length ? <ul>{doc.nextActions.map((text, i) => <li key={i}>{text}</li>)}</ul> : <p className="muted">{m.none}</p>}
      </Card>
      <Card><h2>{m.citations}</h2>{citations(doc.citations)}</Card>
      <Card>
        <SectionHeading title={f.deliveryTitle} />
        {doc.status === 'DELIVERABLE'
          ? <p className="qx-ready">✓ {f.deliveredNote}</p>
          : doc.status !== 'READY_FOR_REVIEW'
            ? <p className="muted">{f.deliverBlockedDocument}</p>
            : operation.data?.status !== 'WAITING_APPROVAL'
              ? <p className="muted">{f.deliverBlockedApproval}</p>
              : approvedReview
                ? <DeliverForm lang={lang} operationId={p.id} documentId={doc.id} approvalId={approvedReview.id} />
                : <p className="muted">{f.deliverBlockedApproval}</p>}
      </Card>
      <Card>
        <p className="muted">{m.exportNote}</p>
        <div className="export-actions">{(['json', 'html'] as const).map(format => <ExportForm key={format} lang={lang} operationId={p.id} documentId={doc.id} format={format} />)}</div>
      </Card>
    </AppShell>
  );
}
