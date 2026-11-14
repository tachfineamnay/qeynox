import { requirePlatformMe, tryApi } from '../../../../lib/api';
import { copy, locale } from '../../../../lib/copy';
import { can, OPERATIONS } from '../../../../lib/permissions';
import { Badge, Card, Empty, Notice, PageHeader, PermissionDenied, Shell } from '../../../../components/shell';
import type { ReleasesView } from '../../../../lib/types';

export default async function ReleasesPage({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const allowed = can(me.permissions, OPERATIONS);
  const result = allowed ? await tryApi<ReleasesView>('/v1/platform/operations/releases') : null;
  const unavailable = (value: string | null | undefined) => value === null || value === undefined || value.length === 0 ? <Badge tone="warning">{t.operationsUnavailable}</Badge> : <>{value}</>;
  return (
    <Shell lang={lang} path="/operations" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <PageHeader title={t.operationsReleasesTitle} intro={t.operationsReleasesIntro} />
      {!allowed ? <PermissionDenied lang={lang} /> : null}
      {result && !result.ok ? <Notice tone="warning" title={t.operationsUnavailable}>{t.apiCode + ': ' + result.code}</Notice> : null}
      {result && result.ok ? (
        <>
          <Card>
            <h2>{t.operationsVersion}</h2>
            <dl className="kv">
              <dt>{t.operationsVersion}</dt><dd>{unavailable(result.value.version.version.value)}</dd>
              <dt>{t.operationsCommit}</dt><dd>{unavailable(result.value.version.commit.value)}</dd>
              <dt>{t.operationsDeployedAt}</dt><dd>{unavailable(result.value.version.deployedAt.value)}</dd>
              <dt>{t.operationsNode}</dt><dd>{result.value.version.nodeVersion}</dd>
              <dt>{t.operationsUptime}</dt><dd>{result.value.version.uptimeSeconds}</dd>
              <dt>{t.operationsLastCheck}</dt><dd>{result.value.lastCheck ? new Date(result.value.lastCheck).toLocaleString(lang) : <Badge tone="warning">{t.operationsUnavailable}</Badge>}</dd>
              <dt>{t.operationsMigrations}</dt><dd>{result.value.migrations ? result.value.migrations.count + (result.value.migrations.latest ? ' · ' + result.value.migrations.latest : '') : <Badge tone="warning">{t.operationsUnavailable}</Badge>}</dd>
            </dl>
          </Card>
          <Card>
            <h2>{t.operationsAnomalies}</h2>
            {result.value.anomalies ? (
              result.value.anomalies.recent.length === 0 ? <Empty>{t.operationsNoAnomalies}</Empty> : (
                <ul className="timeline">
                  {result.value.anomalies.recent.map(entry => (
                    <li key={entry.action + entry.happenedAt}>
                      <strong>{entry.action}</strong>{' '}<Badge tone={entry.outcome === 'DENIED' ? 'warning' : 'danger'}>{entry.outcome}</Badge>
                      <small>{new Date(entry.happenedAt).toLocaleString(lang)}</small>
                      <p>{entry.reason ?? '—'}</p>
                    </li>
                  ))}
                </ul>
              )
            ) : <p className="muted">{t.operationsUnavailable}</p>}
          </Card>
          <Card>
            <h2>{t.operationsResources}</h2>
            <p><strong>{t.operationsCoolify + ': '}</strong><Badge tone={result.value.resources.status === 'CONFIGURED' ? 'success' : 'warning'}>{result.value.resources.status}</Badge>{' '}
              {result.value.resources.reason ? <code>{result.value.resources.reason}</code> : null}</p>
            {result.value.resources.status !== 'CONFIGURED' ? <p className="muted">{t.operationsConfigHint}</p> : null}
            <p className="muted">{t.operationsReadOnly}</p>
          </Card>
        </>
      ) : null}
    </Shell>
  );
}
