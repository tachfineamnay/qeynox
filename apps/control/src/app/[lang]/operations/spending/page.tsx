import Link from 'next/link';
import { requirePlatformMe } from '../../../../lib/api';
import { providerSpendingSchema, tryParsed } from '../../../../lib/operations';
import { copy, locale } from '../../../../lib/copy';
import { betaOperationsCopy } from '../../../../lib/beta-operations-copy';
import { can, OPERATIONS, READ_BETA } from '../../../../lib/permissions';
import { ApiErrorNotice, Badge, Card, Empty, Notice, PageHeader, PermissionDenied, Shell } from '../../../../components/shell';

export default async function SpendingPage({params,searchParams}:{params:Promise<{lang:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const lang=locale((await params).lang),t=copy[lang],b=betaOperationsCopy[lang],me=await requirePlatformMe(lang),allowed=can(me.permissions,OPERATIONS);
  const raw=await searchParams;
  const workspace=typeof raw.workspaceId==='string'?raw.workspaceId:'';
  const operation=typeof raw.operationId==='string'?raw.operationId:'';
  const valid=/^[A-Za-z0-9_-]{4,120}$/.test(workspace)&&(!operation||/^[A-Za-z0-9_-]{4,120}$/.test(operation));
  const query=new URLSearchParams({workspaceId:workspace});if(operation)query.set('operationId',operation);
  const result=allowed&&valid?await tryParsed('/v1/platform/operations/spending?'+query,providerSpendingSchema):null;
  return <Shell lang={lang} path="/operations/spending" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
    <PageHeader title={b.spending} intro={b.spendingIntro}/>
    {!allowed?<PermissionDenied lang={lang}/>:<>
      <form className="card form" method="get" action={'/admin/'+lang+'/operations/spending'}><label className="field"><span>{b.workspace}</span><input name="workspaceId" defaultValue={workspace} required pattern="[A-Za-z0-9_-]{4,120}"/></label><label className="field"><span>{b.operation}</span><input name="operationId" defaultValue={operation} pattern="[A-Za-z0-9_-]{4,120}"/></label><button className="button">{t.filter}</button></form>
      {!valid?<p className="muted">{b.workspaceRequired}</p>:null}
      {can(me.permissions,READ_BETA)&&valid?<p><Link href={'/'+lang+'/beta?workspaceId='+encodeURIComponent(workspace)}>{t.navBeta}</Link></p>:null}
      {result&&!result.ok?<ApiErrorNotice lang={lang} code={result.code}/>:null}
      {result?.ok?<>
        {result.value.truncated?<Notice tone="warning" title={t.operationsUnavailable}>{b.partial}</Notice>:null}
        <Card><h2>{b.cost}</h2>{!result.value.items.length?<Empty>{t.noResults}</Empty>:<div className="table-wrap"><table><thead><tr><th>{b.provider}</th><th>{t.betaCurrency}</th><th>{b.origin}</th><th>{b.cost}</th><th>{b.calls}</th><th>{b.tokens}</th></tr></thead><tbody>{result.value.items.map(row=><tr key={row.provider+row.currency+row.origin}><td>{row.provider}</td><td>{row.currency}</td><td><Badge tone={row.origin==='UNKNOWN'?'warning':'neutral'}>{row.origin}</Badge></td><td>{row.costMinor??'UNKNOWN'}</td><td>{row.calls.toLocaleString(lang)}</td><td>{row.tokensIn??'—'} / {row.tokensOut??'—'}</td></tr>)}</tbody></table></div>}</Card>
        <Card><h2>{b.reservations}</h2>{!result.value.reservations.length?<Empty>{t.noResults}</Empty>:<div className="table-wrap"><table><thead><tr><th>{b.provider}</th><th>{t.betaCurrency}</th><th>{t.status}</th><th>{b.reservations}</th><th>{b.calls}</th></tr></thead><tbody>{result.value.reservations.map(row=><tr key={row.provider+row.currency+row.state}><td>{row.provider}</td><td>{row.currency}</td><td>{row.state}</td><td>{row.reservedMinor}</td><td>{row.calls.toLocaleString(lang)}</td></tr>)}</tbody></table></div>}</Card>
      </>:null}
    </>}
  </Shell>;
}
