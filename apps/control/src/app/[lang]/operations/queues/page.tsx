import Link from 'next/link';
import { requirePlatformMe } from '../../../../lib/api';
import { tryParsed, operationsQueueQuerySchema, queuePageSchema } from '../../../../lib/operations';
import { copy, locale } from '../../../../lib/copy';
import { betaOperationsCopy } from '../../../../lib/beta-operations-copy';
import { can, OPERATIONS } from '../../../../lib/permissions';
import { ApiErrorNotice, Badge, Card, Empty, Notice, PageHeader, PermissionDenied, Shell } from '../../../../components/shell';
import { RecoveryForm } from '../../../../components/beta-operations-forms';

export default async function QueuesPage({ params, searchParams }: { params:Promise<{lang:string}>; searchParams:Promise<Record<string,string|string[]|undefined>> }) {
  const lang=locale((await params).lang), t=copy[lang], b=betaOperationsCopy[lang];
  const me=await requirePlatformMe(lang), allowed=can(me.permissions,OPERATIONS);
  const raw=await searchParams;
  const parsed=operationsQueueQuerySchema.safeParse(Object.fromEntries(Object.entries(raw).filter(([,value])=>typeof value==='string'&&value.length)));
  const input=parsed.success?parsed.data:null;
  const query=new URLSearchParams(input?Object.entries(input).map(([key,value])=>[key,String(value)]):{});
  const result=allowed&&input?await tryParsed('/v1/platform/operations/queues?'+query,queuePageSchema):null;
  const pageHref=(offset:number)=>{const next=new URLSearchParams(query);next.set('offset',String(offset));return '/'+lang+'/operations/queues?'+next;};
  return <Shell lang={lang} path="/operations/queues" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
    <PageHeader title={b.queues} intro={b.queueIntro}/>
    {!allowed?<PermissionDenied lang={lang}/>:<>
      <form className="card form" method="get" action={'/admin/'+lang+'/operations/queues'}>
        <label className="field"><span>{b.kind}</span><select name="kind" defaultValue={input?.kind??'OUTBOX'}>{(['OUTBOX','INGESTION','DELETION','EMAIL'] as const).map((kind,index)=><option key={kind} value={kind}>{[b.outbox,b.ingestion,b.deletion,b.email][index]}</option>)}</select></label>
        <label className="field"><span>{b.workspace}</span><input name="workspaceId" defaultValue={input?.workspaceId??''} pattern="[A-Za-z0-9_-]{4,120}"/></label>
        <label className="field"><span>{b.operation}</span><input name="operationId" defaultValue={input?.operationId??''} pattern="[A-Za-z0-9_-]{4,120}"/></label>
        <label className="field"><span>{t.status}</span><input name="state" defaultValue={input?.state??''} pattern="[A-Z_]{2,30}" placeholder="PENDING / FAILED / UNKNOWN"/></label>
        <button className="button">{t.filter}</button>
      </form>
      {!parsed.success?<ApiErrorNotice lang={lang} code="INVALID_INPUT"/>:null}
      {result&&!result.ok?<ApiErrorNotice lang={lang} code={result.code}/>:null}
      <Notice tone="warning" title={b.recovery}>{b.recoveryHint+' '+b.noRecovery}</Notice>
      {result?.ok?<Card>{result.value.items.length===0?<Empty>{t.noResults}</Empty>:<div className="table-wrap"><table><thead><tr><th>ID / {b.workspace}</th><th>{t.status}</th><th>{b.attempts}</th><th>{b.failure}</th><th>{b.next}</th><th>{t.action}</th></tr></thead><tbody>{result.value.items.map(item=><tr key={item.id}>
        <td><code>{item.id}</code><br/>{item.workspaceId??'—'}{item.operationId?<p><Link href={'/'+lang+'/operations/'+encodeURIComponent(item.operationId)}>{b.operation}: {item.operationId}</Link></p>:null}{item.documentId?<p>{b.document}: <code>{item.documentId}</code></p>:null}</td>
        <td><Badge tone={item.state==='FAILED'||item.uncertain?'danger':'neutral'}>{item.state}</Badge>{item.uncertain?<p>{b.uncertain}</p>:null}</td><td>{item.attempts}</td><td>{item.errorCode?<code>{item.errorCode}</code>:'—'}</td>
        <td>{item.nextAttemptAt?new Date(item.nextAttemptAt).toLocaleString(lang):'—'}<br/>{item.leaseExpiresAt?new Date(item.leaseExpiresAt).toLocaleString(lang):'—'}</td>
        <td>{item.canExpedite&&item.workspaceId?<RecoveryForm lang={lang} action="EXPEDITE_OUTBOX" id={item.id} workspaceId={item.workspaceId} operationId={item.operationId??undefined}/>:null}</td>
      </tr>)}</tbody></table></div>}
      <div className="pager">{result.value.offset>0?<Link href={pageHref(Math.max(0,result.value.offset-result.value.limit))}>{b.previous}</Link>:null}{result.value.hasMore&&result.value.offset+result.value.limit<=10000?<Link href={pageHref(result.value.offset+result.value.limit)}>{b.nextPage}</Link>:null}</div><p className="muted">{b.bounded}</p></Card>:null}
    </>}
  </Shell>;
}
