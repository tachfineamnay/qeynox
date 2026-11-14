import { requirePlatformMe, tryApi } from '../../../../lib/api';
import { copy, locale } from '../../../../lib/copy';
import { can, OPERATIONS } from '../../../../lib/permissions';
import { Badge, Card, Empty, Notice, PageHeader, PermissionDenied, Shell } from '../../../../components/shell';
import type { HealthView, ResourcesView } from '../../../../lib/types';

export default async function HealthPage({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const allowed = can(me.permissions, OPERATIONS);
  const healthResult = allowed ? await tryApi<HealthView>('/v1/platform/operations/health') : null;
  const resourcesResult = allowed ? await tryApi<ResourcesView>('/v1/platform/operations/resources') : null;
  return (
    <Shell lang={lang} path="/operations" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <PageHeader title={t.operationsHealthTitle} intro={t.operationsHealthIntro} />
      {!allowed ? <PermissionDenied lang={lang} /> : null}
      {healthResult && !healthResult.ok ? <Notice tone="warning" title={t.operationsUnavailable}>{t.apiCode + ': ' + healthResult.code}</Notice> : null}
      {healthResult && healthResult.ok ? (
        <Card>
          <h2>{t.operationsCheck}</h2>
          <p className="muted">{t.operationsCheckedAt + ': ' + new Date(healthResult.value.checkedAt).toLocaleString(lang)}</p>
          <div className="table-wrap"><table>
            <thead><tr><th>{t.operationsCheck}</th><th>{t.status}</th><th>{t.reason}</th></tr></thead>
            <tbody>
              {healthResult.value.checks.map(check => (
                <tr key={check.name}>
                  <td>{check.name}</td>
                  <td><Badge tone={check.status === 'OK' ? 'success' : 'warning'}>{check.status}</Badge></td>
                  <td>{check.detail}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      ) : null}
      <Card>
        <h2>{t.operationsResources}</h2>
        {resourcesResult && resourcesResult.ok ? (
          <>
            <p><strong>{t.operationsCoolify + ': '}</strong><Badge tone={resourcesResult.value.capability.status === 'CONFIGURED' ? 'success' : 'warning'}>{resourcesResult.value.capability.status}</Badge>{' '}
              {resourcesResult.value.capability.reason ? <code>{resourcesResult.value.capability.reason}</code> : null}</p>
            {resourcesResult.value.resources.length === 0 ? (
              <><p className="muted">{t.operationsConfigHint}</p><Empty>{t.operationsUnavailable}</Empty></>
            ) : (
              <div className="table-wrap"><table>
                <thead><tr><th>{t.operationsResourceName}</th><th>{t.operationsResourceType}</th><th>{t.operationsResourceStatus}</th><th>{t.operationsReadOnly}</th></tr></thead>
                <tbody>
                  {resourcesResult.value.resources.map(resource => (
                    <tr key={resource.type + '-' + resource.id}>
                      <td>{resource.name}</td><td>{resource.type}</td>
                      <td><Badge tone={resource.status === 'running:healthy' || resource.status === 'healthy' ? 'success' : 'warning'}>{resource.status}</Badge></td>
                      <td>{t.operationsReadOnly}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </>
        ) : <Notice tone="warning" title={t.operationsUnavailable}>{resourcesResult && !resourcesResult.ok ? resourcesResult.code : 'UNAVAILABLE'}</Notice>}
      </Card>
    </Shell>
  );
}
