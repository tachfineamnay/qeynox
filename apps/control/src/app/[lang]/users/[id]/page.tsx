import Link from 'next/link';
import { requirePlatformMe, tryApi } from '../../../../lib/api';
import { reactivateUserAction, revokeUserSessionsAction, suspendUserAction } from '../../../../lib/actions';
import { copy, locale } from '../../../../lib/copy';
import { ADMINISTRATION, can, READ_ACTIVITY, READ_USERS } from '../../../../lib/permissions';
import { Badge, Card, Empty, Notice, OutcomeNotice, PageHeader, PermissionDenied, Shell } from '../../../../components/shell';
import type { ActivityPageView, UserDetailView, UserSessionsView } from '../../../../lib/types';

export default async function UserDetailPage({ params, searchParams }: { params: Promise<{ lang: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const resolved = await params;
  const lang = locale(resolved.lang);
  const userId = resolved.id;
  const query = await searchParams;
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const allowed = can(me.permissions, READ_USERS);
  const canAdminister = can(me.permissions, ADMINISTRATION);
  const canReadActivity = can(me.permissions, READ_ACTIVITY);
  const detailResult = allowed ? await tryApi<UserDetailView>('/v1/platform/users/' + encodeURIComponent(userId)) : null;
  const sessionsResult = allowed ? await tryApi<UserSessionsView>('/v1/platform/users/' + encodeURIComponent(userId) + '/sessions') : null;
  const activityResult = canReadActivity ? await tryApi<ActivityPageView>('/v1/platform/users/' + encodeURIComponent(userId) + '/activity?limit=20') : null;
  const done = typeof query.done === 'string' ? query.done : undefined;
  const error = typeof query.error === 'string' ? query.error : undefined;
  const base = '/' + lang + '/users/' + encodeURIComponent(userId);

  return (
    <Shell lang={lang} path="/users" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <p className="pager"><Link href={'/' + lang + '/users'}>{t.previous}</Link></p>
      {!allowed ? <PermissionDenied lang={lang} /> : null}
      <OutcomeNotice lang={lang} done={done} error={error} />
      {detailResult && !detailResult.ok ? <Notice tone="warning" title={t.apiUnavailable}>{t.apiCode + ': ' + detailResult.code}</Notice> : null}
      {detailResult && detailResult.ok ? (
        <>
          <PageHeader
            title={detailResult.value.email}
            intro={t.userTitle}
            actions={<Badge tone={detailResult.value.status === 'ACTIVE' ? 'success' : 'warning'}>{detailResult.value.status === 'ACTIVE' ? t.active : t.suspended}</Badge>}
          />
          <div className="grid">
            <Card>
              <h2>{t.overview}</h2>
              <dl className="kv">
                <dt>{'User'}</dt><dd>{detailResult.value.userId}</dd>
                <dt>{t.emailLabel}</dt><dd>{detailResult.value.email}</dd>
                <dt>{t.localeLabel}</dt><dd>{detailResult.value.locale}</dd>
                <dt>{t.createdAt}</dt><dd>{new Date(detailResult.value.createdAt).toLocaleString(lang)}</dd>
                <dt>{t.status}</dt><dd>{detailResult.value.status}</dd>
                <dt>{t.disabledAt}</dt><dd>{detailResult.value.disabledAt ? new Date(detailResult.value.disabledAt).toLocaleString(lang) : '—'}</dd>
                <dt>{t.platformRoles}</dt><dd>{detailResult.value.platformRoles ? detailResult.value.platformRoles.join(' · ') : '—'}</dd>
                <dt>{t.activeSessions}</dt><dd>{detailResult.value.sessions.active + ' / ' + detailResult.value.sessions.total}</dd>
                <dt>{t.lastUsed}</dt><dd>{detailResult.value.sessions.lastUsedAt ? new Date(detailResult.value.sessions.lastUsedAt).toLocaleString(lang) : '—'}</dd>
              </dl>
            </Card>
            <Card>
              <h2>{t.workspaces}</h2>
              {detailResult.value.workspaces.length === 0 ? <Empty>{t.noResults}</Empty> : (
                <div className="table-wrap"><table>
                  <thead><tr><th>{t.workspace}</th><th>{t.role}</th><th>{t.membershipStatus}</th><th>{t.joinedAt}</th></tr></thead>
                  <tbody>
                    {detailResult.value.workspaces.map(workspace => (
                      <tr key={workspace.workspaceId}>
                        <td><Link href={'/' + lang + '/organizations/' + encodeURIComponent(workspace.workspaceId)}>{workspace.name}</Link></td>
                        <td>{workspace.role}</td>
                        <td>{workspace.membershipStatus}</td>
                        <td>{workspace.joinedAt ? new Date(workspace.joinedAt).toLocaleDateString(lang) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </Card>
            <Card>
              <h2>{t.onboardingTitle}</h2>
              <p className="muted">{t.onboardingIntro}</p>
              {(detailResult.value.onboarding ?? []).length === 0 ? <Empty>{t.onboardingNotStarted}</Empty> : (
                <div className="table-wrap"><table>
                  <thead><tr><th>{t.workspace}</th><th>{t.status}</th><th>{t.onboardingStep}</th><th>{t.onboardingStarted}</th><th>{t.onboardingCompleted}</th></tr></thead>
                  <tbody>
                    {(detailResult.value.onboarding ?? []).map(record => (
                      <tr key={'onboarding-' + record.workspaceId}>
                        <td>{record.workspaceId}</td>
                        <td><Badge tone={record.status === 'COMPLETED' ? 'success' : record.status === 'NOT_STARTED' ? 'neutral' : 'warning'}>{record.status === 'NOT_STARTED' ? t.onboardingNotStarted : record.status}</Badge></td>
                        <td>{record.step ?? '—'}</td>
                        <td>{record.startedAt ? new Date(record.startedAt).toLocaleString(lang) : '—'}</td>
                        <td>{record.completedAt ? new Date(record.completedAt).toLocaleString(lang) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </Card>
          </div>
          {sessionsResult && sessionsResult.ok ? (
            <Card>
              <h2>{t.sessions}</h2>
              <p className="muted">{t.activeSessions + ': ' + sessionsResult.value.summary.active + ' / ' + sessionsResult.value.summary.total}</p>
              <div className="table-wrap"><table>
                <thead><tr><th>{t.sessionKind}</th><th>{t.createdAt}</th><th>{t.expiresAt}</th><th>{t.lastUsed}</th><th>{t.result}</th></tr></thead>
                <tbody>
                  {sessionsResult.value.sessions.map(session => (
                    <tr key={'workspace-' + session.sessionId}>
                      <td>{t.workspaceSession}</td>
                      <td>{new Date(session.createdAt).toLocaleString(lang)}</td>
                      <td>{new Date(session.expiresAt).toLocaleString(lang)}</td>
                      <td>{session.lastUsedAt ? new Date(session.lastUsedAt).toLocaleString(lang) : '—'}</td>
                      <td><Badge tone={session.active ? 'success' : 'neutral'}>{session.revokedAt ? t.revokedAt : session.active ? t.active : t.expired}</Badge></td>
                    </tr>
                  ))}
                  {(sessionsResult.value.platformSessions ?? []).map(session => (
                    <tr key={'platform-' + session.sessionId}>
                      <td>{t.platformSession}</td>
                      <td>{new Date(session.createdAt).toLocaleString(lang)}</td>
                      <td>{new Date(session.expiresAt).toLocaleString(lang)}</td>
                      <td>{session.lastUsedAt ? new Date(session.lastUsedAt).toLocaleString(lang) : '—'}</td>
                      <td><Badge tone={session.active ? 'success' : 'neutral'}>{session.revokedAt ? t.revokedAt : session.active ? t.active : t.expired}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              {canAdminister ? (
                <div className="grid">
                  {detailResult.value.status === 'ACTIVE' ? (
                    <form className="card form" action={suspendUserAction}>
                      <h2>{t.suspend}</h2><p className="muted">{t.destructiveHint}</p>
                      <input type="hidden" name="lang" value={lang} /><input type="hidden" name="userId" value={userId} />
                      <label className="field"><span>{t.justification}</span><textarea name="reason" required minLength={10} maxLength={500} rows={3} /></label>
                      <button className="button danger" type="submit">{t.suspend}</button>
                    </form>
                  ) : (
                    <form className="card form" action={reactivateUserAction}>
                      <h2>{t.reactivate}</h2><p className="muted">{t.destructiveHint}</p>
                      <input type="hidden" name="lang" value={lang} /><input type="hidden" name="userId" value={userId} />
                      <label className="field"><span>{t.justification}</span><textarea name="reason" required minLength={10} maxLength={500} rows={3} /></label>
                      <button className="button" type="submit">{t.reactivate}</button>
                    </form>
                  )}
                  <form className="card form" action={revokeUserSessionsAction}>
                    <h2>{t.revokeSessions}</h2><p className="muted">{t.destructiveHint}</p>
                    <input type="hidden" name="lang" value={lang} /><input type="hidden" name="userId" value={userId} />
                    <label className="field"><span>{t.justification}</span><textarea name="reason" required minLength={10} maxLength={500} rows={3} /></label>
                    <button className="button secondary" type="submit">{t.revokeSessions}</button>
                  </form>
                </div>
              ) : <p className="muted">{t.permissionDenied}</p>}
            </Card>
          ) : null}
          {activityResult ? (
            <Card>
              <h2>{t.activity}</h2><p className="muted">{t.activityHint}</p>
              {activityResult.ok ? (
                activityResult.value.items.length === 0 ? <Empty>{t.noResults}</Empty> : (
                  <ul className="timeline">
                    {activityResult.value.items.map(item => (
                      <li key={item.id}>
                        <strong>{item.action}</strong>{' '}<Badge tone={item.outcome === 'SUCCESS' ? 'success' : item.outcome === 'DENIED' ? 'warning' : 'danger'}>{item.outcome}</Badge>
                        <small>{new Date(item.happenedAt).toLocaleString(lang)}{item.actorUserId ? ' · ' + t.actor + ': ' + item.actorUserId : ''}{item.reason ? ' · ' + t.reason + ': ' + item.reason : ''}</small>
                      </li>
                    ))}
                  </ul>
                )
              ) : <Notice tone="warning" title={t.apiUnavailable}>{t.apiCode + ': ' + activityResult.code}</Notice>}
            </Card>
          ) : null}
        </>
      ) : null}
    </Shell>
  );
}
