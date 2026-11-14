import Link from 'next/link';
import { requirePlatformMe, tryApi } from '../../../../../lib/api';
import { copy, locale } from '../../../../../lib/copy';
import { can, OPERATIONS } from '../../../../../lib/permissions';
import { Badge, Card, Empty, Notice, PageHeader, PermissionDenied, Shell } from '../../../../../components/shell';
import type { OperationDetailView } from '../../../../../lib/types';

export default async function OperationDetailPage({ params }: { params: Promise<{ lang: string; id: string }> }) {
  const resolved = await params;
  const lang = locale(resolved.lang);
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const allowed = can(me.permissions, OPERATIONS);
  const result = allowed ? await tryApi<OperationDetailView>('/v1/platform/operations/' + encodeURIComponent(resolved.id)) : null;
  return (
    <Shell lang={lang} path="/operations" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <p className="pager"><Link href={'/admin/' + lang + '/operations'}>{t.operationsBack}</Link></p>
      {!allowed ? <PermissionDenied lang={lang} /> : null}
      {result && !result.ok ? <Notice tone="warning" title={t.operationsUnavailable}>{t.apiCode + ': ' + result.code}</Notice> : null}
      {result && result.ok ? (
        <>
          <PageHeader
            title={result.value.summary.title}
            intro={t.operationsDetailTitle}
            actions={<Badge tone={result.value.summary.status === 'COMPLETED' ? 'success' : result.value.summary.status === 'FAILED' ? 'danger' : 'warning'}>{result.value.summary.status}</Badge>}
          />
          <div className="grid">
            <Card>
              <h2>{t.operationsSummary}</h2>
              <dl className="kv">
                <dt>{t.operationsWorkspace}</dt><dd>{result.value.summary.workspaceName ?? result.value.summary.workspaceId}</dd>
                <dt>{'Operation'}</dt><dd><code>{result.value.summary.operationId}</code></dd>
                <dt>{'Version'}</dt><dd>{result.value.summary.version}</dd>
                <dt>{t.operationsUpdated}</dt><dd>{new Date(result.value.summary.lastActivityAt).toLocaleString(lang)}</dd>
                <dt>{t.operationsSteps}</dt><dd>{result.value.summary.currentRevisionId ?? t.operationsUnavailable}</dd>
              </dl>
            </Card>
            <Card>
              <h2>{t.operationsDispatch}</h2>
              {result.value.runtime.dispatch.length === 0 ? <Empty>{t.operationsUnavailable}</Empty> : (
                <div className="table-wrap"><table>
                  <thead><tr><th>{'Topic'}</th><th>{t.status}</th><th>{t.operationsAttempts}</th></tr></thead>
                  <tbody>{result.value.runtime.dispatch.map(row => <tr key={row.id}><td>{row.topic}</td><td><Badge tone={row.state === 'SENT' || row.state === 'COMPLETED' ? 'success' : 'warning'}>{row.state}</Badge></td><td>{row.attempts}{row.lastErrorCode ? ' · ' + row.lastErrorCode : ''}</td></tr>)}</tbody>
                </table></div>
              )}
            </Card>
          </div>
          <Card>
            <h2>{t.operationsExecutions}</h2>
            {result.value.runtime.executions.length === 0 ? <Empty>{t.operationsUnavailable}</Empty> : (
              <div className="table-wrap"><table>
                <thead><tr><th>{'Provider'}</th><th>{'Run'}</th><th>{t.status}</th></tr></thead>
                <tbody>{result.value.runtime.executions.map(row => <tr key={row.id}><td>{row.provider}</td><td>{row.runId ?? '—'}</td><td>{row.status}</td></tr>)}</tbody>
              </table></div>
            )}
            <h2>{t.operationsAttempts}</h2>
            {result.value.runtime.attempts.length === 0 ? <Empty>{t.operationsUnavailable}</Empty> : (
              <div className="table-wrap"><table>
                <thead><tr><th>{'#'}</th><th>{'Step'}</th><th>{t.status}</th></tr></thead>
                <tbody>{result.value.runtime.attempts.map(row => <tr key={row.id}><td>{row.sequence}</td><td><code>{row.stepId}</code></td><td>{row.state}</td></tr>)}</tbody>
              </table></div>
            )}
          </Card>
          <Card>
            <h2>{t.operationsHistory}</h2>
            {result.value.events.length === 0 ? <Empty>{t.operationsNoHistory}</Empty> : (
              <ul className="timeline">
                {result.value.events.map(event => (
                  <li key={event.sequence}>
                    <strong>{event.kind}</strong>{' '}<Badge tone="neutral">{event.actorType}</Badge>
                    <small>{new Date(event.occurredAt).toLocaleString(lang) + ' · seq ' + event.sequence}</small>
                    <p><code>{JSON.stringify(event.data).slice(0, 400)}</code></p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <h2>{t.operationsRecovery}</h2>
            {result.value.incidents.length === 0 ? <Empty>{t.operationsNoIncidents}</Empty> : (
              <ul className="timeline">
                {result.value.incidents.map(incident => (
                  <li key={incident.id}>
                    <strong>{incident.category + ' · ' + incident.status}</strong>
                    <small>{new Date(incident.updatedAt).toLocaleString(lang)}</small>
                    <p>{incident.reason}</p>
                    {incident.actions.length ? <ul className="plain-list">{incident.actions.map(action => <li key={action.id}><code>{action.action}</code> — {action.reason}</li>)}</ul> : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted">{t.operationsReadOnly}</p>
          </Card>
        </>
      ) : null}
    </Shell>
  );
}
