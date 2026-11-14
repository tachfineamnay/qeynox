import { requirePlatformMe, tryApi } from '../../../lib/api';
import { copy, locale } from '../../../lib/copy';
import { can, CONSULTATION } from '../../../lib/permissions';
import { ApiErrorNotice, Badge, Card, Empty, Notice, PageHeader, PermissionDenied, Shell } from '../../../components/shell';
import type { AuditEntryView } from '../../../lib/types';

export default async function AuditPage({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const allowed = can(me.permissions, CONSULTATION);
  const result = allowed ? await tryApi<AuditEntryView[]>('/v1/platform/audit?limit=100') : null;
  return (
    <Shell lang={lang} path="/audit" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <PageHeader title={t.auditTitle} intro={t.auditIntro} />
      {!allowed ? <PermissionDenied lang={lang} /> : null}
      {result && !result.ok ? <ApiErrorNotice lang={lang} code={result.code} /> : null}
      {result && result.ok ? (
        <Card>
          {result.value.length === 0 ? <Empty>{t.noResults}</Empty> : (
            <div className="table-wrap"><table>
              <thead><tr><th>{t.date}</th><th>{t.actor}</th><th>{t.action}</th><th>{t.target}</th><th>{t.permissions}</th><th>{t.result}</th><th>{t.reason}</th></tr></thead>
              <tbody>
                {result.value.map(entry => (
                  <tr key={entry.id}>
                    <td>{new Date(entry.happenedAt).toLocaleString(lang)}</td>
                    <td>{entry.actorUserId ?? '—'}</td>
                    <td>{entry.action}</td>
                    <td>{entry.targetType + (entry.targetId ? ' · ' + entry.targetId : '')}</td>
                    <td>{entry.permission ?? '—'}</td>
                    <td><Badge tone={entry.outcome === 'SUCCESS' ? 'success' : entry.outcome === 'DENIED' ? 'warning' : 'danger'}>{entry.outcome}</Badge></td>
                    <td>{entry.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>
      ) : null}
    </Shell>
  );
}