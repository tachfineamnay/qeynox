import Link from 'next/link';
import { idSchema } from '@qeynox/contracts';
import { AppShell, Card, Feedback, StatusBadge } from '../../../../../../components/ui';
import { ExportForm } from '../../../../../../components/mission-controls';
import { copy, locale } from '../../../../../../lib/copy';
import { missionCopy } from '../../../../../../lib/mission-copy';
import { read, documentSchema, safeUrl } from '../../../../../../lib/mission';
export default async function Page({ params }: { params: Promise<{ lang: string; id: string; documentId: string }> }) {
 const p = await params; const lang = locale(p.lang); const t = copy[lang]; const m = missionCopy(lang);
 const id = idSchema.safeParse(p.id); const docId = idSchema.safeParse(p.documentId);
 const result = id.success && docId.success ? await read(`/v1/operations/${id.data}/documents/${docId.data}`, documentSchema) : { code: 'INVALID_INPUT' };
 const doc = result.data;
 if (!doc || doc.operationId !== p.id || doc.id !== p.documentId) return <AppShell lang={lang} active="missions"><Feedback title={`${m.unavailable} (${result.code ?? 'INVALID_RESPONSE'})`} error/></AppShell>;
 const citations = (items: typeof doc.citations) => items.length ? <ul className="citation-list">{items.map((c,i) => <li key={`${c.sourceId}-${i}`}><strong>{c.provider}</strong> · {safeUrl(c.uri) ? <a href={safeUrl(c.uri)} target="_blank" rel="noopener noreferrer">{c.uri}</a> : <span>{m.noSource}</span>}<p className="muted">{m.retrieved}: {c.retrievedAt} · {c.publishedAt ? `${m.published}: ${c.publishedAt}` : m.unknownDate}</p>{c.fingerprint && <details><summary>SHA-256</summary><code>{c.fingerprint}</code></details>}</li>)}</ul> : <p>{m.noSource}</p>;
 return <AppShell lang={lang} active="missions"><Link href={`/${lang}/missions/${p.id}`}>← {t.detail}</Link><header className="page-intro"><h1>{doc.title}</h1><p>{doc.objective}</p><p>{m.version} {doc.version}</p><StatusBadge status={doc.status} lang={lang}/></header>
 <Card><h2>{m.scope}</h2><ul>{doc.scope.map((text,i) => <li key={i}>{text}</li>)}</ul><h2>{m.findings}</h2>{doc.findings.length === 0 && <p>{m.empty}</p>}{doc.findings.map((finding,i) => <article className="finding" key={`${finding.claimId}-${i}`}><h3>{finding.statement}</h3><StatusBadge status={finding.status} lang={lang}/><ul>{finding.limitations.map((text,j) => <li key={j}>{text}</li>)}</ul>{citations(finding.citations)}</article>)}</Card>
 <Card><h2>{m.limits}</h2><ul>{doc.limitations.map((text,i) => <li key={i}>{text}</li>)}</ul><h3>{m.unresolved}</h3><ul>{doc.unresolved.map((text,i) => <li key={i}><code>{text}</code></li>)}</ul><h2>{m.next}</h2><ul>{doc.nextActions.map((text,i) => <li key={i}>{text}</li>)}</ul></Card>
 <Card><h2>{m.citations}</h2>{citations(doc.citations)}</Card><Card><p className="muted">{m.exportNote}</p><div className="export-actions">{(['json','html'] as const).map(format => <ExportForm key={format} lang={lang} operationId={p.id} documentId={doc.id} format={format}/>)}</div></Card>
 </AppShell>;
}
