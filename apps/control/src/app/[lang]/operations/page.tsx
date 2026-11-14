import Link from 'next/link';
import type { ReactNode } from 'react';
import { requirePlatformMe, tryApi } from '../../../lib/api';
import { copy, locale } from '../../../lib/copy';
import { can, OPERATIONS } from '../../../lib/permissions';
import { ApiErrorNotice, Badge, Card, Empty, Notice, PageHeader, PermissionDenied, Shell } from '../../../components/shell';
import type { OperationsListView, RecoveryIncidentView } from '../../../lib/types';

function first(value: string | string[] | undefined): string { return typeof value === 'string' ? value : ''; }

export default async function OperationsPage({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lang = locale((await params).lang);
  const query = await searchParams;
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const allowed = can(me.permissions, OPERATIONS);
  const status = first(query.status).trim();
  const listResult = allowed ? await tryApi<OperationsListView>('/v1/platform/operations' + (status.length ? '?status=' + encodeURIComponent(status) : '')) : null;
  const incidentsResult = allowed ? await tryApi<{ items: RecoveryIncidentView[] }>('/v1/platform/operations/incidents') : null;
  const counts = listResult && listResult.ok ? listResult.value.counts : null;
  let content: ReactNode;
  if (!allowed) content = <PermissionDenied lang={lang} />;
  else if (!listResult || !listResult.ok) content = <ApiErrorNotice lang={lang} code={listResult && !listResult.ok ? listResult.code : 'UNAVAILABLE'} />;
  else if (listResult.value.items.length === 0) content = <Card><Empty>{t.operationsEmpty}</Empty></Card>;
  else {
    content = (
      <Card>
        <div className="table-wrap"><table>
          <thead><tr><th>{t.action}</th><th>{t.operationsWorkspace}</th><th>{t.status}</th><th>{t.operationsSteps}</th><th>{t.operationsPendingApprovals}</th><th>{t.operationsUpdated}</th><th>{t.operationsOpen}</th></tr></thead>
          <tbody>
            {listResult.value.items.map(item => (
              <tr key={item.operationId}>
                <td>{item.title}<br /><code>{item.operationId}</code></td>
                <td>{item.workspaceName ?? item.workspaceId}</td>
                <td><Badge tone={item.status === 'COMPLETED' ? 'success' : item.status === 'FAILED' ? 'danger' : item.status === 'WAITING_APPROVAL' ? 'warning' : 'neutral'}>{item.status}</Badge></td>
                <td>{item.completedSteps + ' / ' + item.stepCount}</td>
                <td>{item.pendingApprovals}</td>
                <td>{new Date(item.lastActivityAt).toLocaleString(lang)}</td>
                <td><Link href={'/' + lang + '/operations/' + encodeURIComponent(item.operationId)}>{t.operationsOpen}</Link></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>
    );
  }
  return (
    <Shell lang={lang} path="/operations" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <PageHeader title={t.operationsTitle} intro={t.operationsIntro} actions={<Badge tone={allowed ? 'success' : 'warning'}>{allowed ? t.permissionOperations : t.permissionDenied}</Badge>} />
      {allowed ? (
        <Card>
          <h2>{t.operationsStatusCounts}</h2>
          {counts ? (
            <div className="row-actions">
              <Link className="button secondary" href={'/' + lang + '/operations'}>{t.operationsAllStatuses + ' · ' + counts.total}</Link>
              {counts.statuses.map(entry => (
                <Link key={entry.status} className="button secondary" href={'/' + lang + '/operations?status=' + encodeURIComponent(entry.status)}>{entry.status + ' · ' + entry.count}</Link>
              ))}
            </div>
          ) : <p className="muted">{t.operationsUnavailable}</p>}
          {counts ? <p className="muted">{t.operationsAttention + ': ' + counts.attentions.map(entry => entry.attention + '=' + entry.count).join(' · ')}</p> : null}
        </Card>
      ) : null}
      {content}
      <Card>
        <h2>{t.operationsIncidents}</h2>
        {incidentsResult && incidentsResult.ok ? (
          incidentsResult.value.items.length === 0 ? <Empty>{t.operationsNoIncidents}</Empty> : (
            <ul className="timeline">
              {incidentsResult.value.items.map(incident => (
                <li key={incident.id}>
                  <strong>{incident.category + ' · ' + incident.status}</strong>{' '}<Badge tone={incident.status === 'RESOLVED' || incident.status === 'CLOSED' ? 'success' : 'warning'}>{incident.status}</Badge>
                  <small>{new Date(incident.updatedAt).toLocaleString(lang) + ' · ' + incident.operationId}</small>
                  <p>{incident.reason}</p>
                  {incident.actions.length ? <ul className="plain-list">{incident.actions.map(action => <li key={action.id}><code>{action.action}</code> — {action.reason}</li>)}</ul> : null}
                </li>
              ))}
            </ul>
          )
        ) : <Notice tone="warning" title={t.operationsUnavailable}>{incidentsResult && !incidentsResult.ok ? incidentsResult.code : 'UNAVAILABLE'}</Notice>}
      </Card>
      <p className="muted">{t.operationsReadOnly}</p>
    </Shell>
  );
}