import Link from 'next/link';
import { copy, type Locale } from '../lib/copy';
import { betaOperationsCopy } from '../lib/beta-operations-copy';
import { tryParsed, runtimeDiagnosticSchema, providerDiagnosticSchema, storageDiagnosticSchema, migrationsDiagnosticSchema } from '../lib/operations';
import { ApiErrorNotice, Badge, Card, Empty } from './shell';

/** Call only behind the existing OPERATIONS page permission gate; all APIs reauthorize independently. */
export async function OperationsDiagnostics({lang}:{lang:Locale}) {
  const b=betaOperationsCopy[lang],t=copy[lang];
  const [runtime,providers,storage]=await Promise.all([
    tryParsed('/v1/platform/operations/runtime',runtimeDiagnosticSchema),
    tryParsed('/v1/platform/providers',providerDiagnosticSchema),
    tryParsed('/v1/platform/storage',storageDiagnosticSchema),
  ]);
  return <>
    <Card><h2>{b.runtime}</h2><p className="muted">{b.runtimeHint}</p>{!runtime.ok?<ApiErrorNotice lang={lang} code={runtime.code}/>:<><Badge tone={runtime.value.overallState==='OPERATIONAL'?'success':'warning'}>{runtime.value.overallState}</Badge><div className="table-wrap"><table><thead><tr><th>{b.provider}</th><th>{t.status}</th><th>{b.observed}</th><th>{b.missing}</th></tr></thead><tbody>{runtime.value.components.map(row=><tr key={row.id}><td>{row.id}</td><td><Badge tone={row.verifiedLive?'success':'warning'}>{row.state} / {row.status}</Badge>{row.failure?<p><code>{row.failure}</code></p>:null}</td><td>{row.checkedAt?new Date(row.checkedAt).toLocaleString(lang):'—'}<br/>{row.expiresAt?new Date(row.expiresAt).toLocaleString(lang):'—'}</td><td>{row.missing.join(', ')||'—'}</td></tr>)}</tbody></table></div></>}</Card>
    <Card><h2>{b.providers}</h2>{!providers.ok?<ApiErrorNotice lang={lang} code={providers.code}/>:<><p className="muted">{providers.value.boundary}</p><div className="table-wrap"><table><thead><tr><th>{b.provider}</th><th>{t.status}</th><th>{t.reason}</th></tr></thead><tbody>{providers.value.providers.map(row=><tr key={row.connectorId}><td>{row.connectorId} @{row.version}<br/>{row.tools.join(', ')}</td><td><Badge tone="warning">{row.state}</Badge></td><td>{row.reason??'—'}{row.configuredMaxPerMinute!==null?<p>{row.configuredMaxPerMinute} / min</p>:null}</td></tr>)}</tbody></table></div></>}</Card>
    <Card><h2>{b.storage}</h2>{!storage.ok?<ApiErrorNotice lang={lang} code={storage.code}/>:<><Badge tone="warning">{storage.value.storage.status}</Badge>{storage.value.storage.failure?<p><code>{storage.value.storage.failure}</code></p>:null}<p className="muted">{storage.value.boundary}</p>{storage.value.configurationIssues.map(row=><p key={row.key}>{row.key}: <code>{row.code}</code></p>)}</>}<p><Link href={'/'+lang+'/operations/queues?kind=INGESTION&state=FAILED'}>{b.ingestion}</Link>{' · '}<Link href={'/'+lang+'/operations/queues?kind=DELETION&state=FAILED'}>{b.deletion}</Link></p></Card>
  </>;
}
export async function MigrationDiagnostics({lang}:{lang:Locale}) {
  const b=betaOperationsCopy[lang],result=await tryParsed('/v1/platform/operations/migrations',migrationsDiagnosticSchema);
  return <Card><h2>{b.migrations}</h2><p className="muted">{b.migrationHint}</p>{!result.ok?<ApiErrorNotice lang={lang} code={result.code}/>:<><Badge tone={result.value.status==='CURRENT'?'success':'warning'}>{result.value.status}</Badge><p>{b.applied}: {result.value.applied} / {result.value.expected}</p>{([['pending',b.pending],['mismatches',b.mismatches],['unknownApplied',b.unknown],['outOfOrder',b.order]] as const).map(([key,label])=><div key={key}><h3>{label}</h3>{result.value[key].length?<ul>{result.value[key].map(name=><li key={name}><code>{name}</code></li>)}</ul>:<Empty>—</Empty>}</div>)}</>}</Card>;
}
