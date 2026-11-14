import Link from 'next/link';
import { requirePlatformMe, tryApi } from '../../../../lib/api';
import { changeRoleAction, revokeMembershipAction } from '../../../../lib/actions';
import { InviteForm } from '../../../../components/invite-form';
import { copy, locale } from '../../../../lib/copy';
import { ADMINISTRATION, can, READ_ORGANIZATIONS } from '../../../../lib/permissions';
import { Badge, Card, Empty, Notice, OutcomeNotice, PageHeader, PermissionDenied, Shell } from '../../../../components/shell';
import type { MemberPageView, MemberView, OrganizationDetailView } from '../../../../lib/types';

function first(value: string | string[] | undefined): string { return typeof value === 'string' ? value : ''; }

export default async function OrganizationDetailPage({ params, searchParams }: { params: Promise<{ lang: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const resolved = await params;
  const lang = locale(resolved.lang);
  const workspaceId = resolved.id;
  const query = await searchParams;
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const allowed = can(me.permissions, READ_ORGANIZATIONS);
  const canAdminister = can(me.permissions, ADMINISTRATION);
  const roleFilter = ['OWNER', 'ADMIN', 'MEMBER'].includes(first(query.role)) ? first(query.role) : '';
  const statusFilter = ['ACTIVE', 'INVITED', 'REVOKED', 'DECLINED'].includes(first(query.status)) ? first(query.status) : '';
  const membersParams = new URLSearchParams();
  if (roleFilter.length) membersParams.set('role', roleFilter);
  if (statusFilter.length) membersParams.set('status', statusFilter);
  membersParams.set('limit', '100');
  const detailResult = allowed ? await tryApi<OrganizationDetailView>('/v1/platform/organizations/' + encodeURIComponent(workspaceId)) : null;
  const membersResult = allowed ? await tryApi<MemberPageView>('/v1/platform/organizations/' + encodeURIComponent(workspaceId) + '/members?' + membersParams.toString()) : null;
  const done = typeof query.done === 'string' ? query.done : undefined;
  const error = typeof query.error === 'string' ? query.error : undefined;

  return (
    <Shell lang={lang} path="/organizations" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <p className="pager"><Link href={'/' + lang + '/organizations'}>{t.previous}</Link></p>
      {!allowed ? <PermissionDenied lang={lang} /> : null}
      <OutcomeNotice lang={lang} done={done} error={error} />
      {detailResult && !detailResult.ok ? <Notice tone="warning" title={t.apiUnavailable}>{t.apiCode + ': ' + detailResult.code}</Notice> : null}
      {detailResult && detailResult.ok ? (
        <>
          <PageHeader title={detailResult.value.name} intro={t.organizationTitle} actions={<Badge>{detailResult.value.stats.activeMembers + ' ' + t.active.toLowerCase()}</Badge>} />
          <div className="grid">
            <Card>
              <h2>{t.overview}</h2>
              <dl className="kv">
                <dt>{t.workspace}</dt><dd>{detailResult.value.workspaceId}</dd>
                <dt>{t.owners}</dt><dd>{detailResult.value.stats.owners}</dd>
                <dt>{'ADMIN'}</dt><dd>{detailResult.value.stats.admins}</dd>
                <dt>{'MEMBER'}</dt><dd>{detailResult.value.stats.members}</dd>
                <dt>{t.invitedCount}</dt><dd>{detailResult.value.stats.invited}</dd>
                <dt>{t.createdAt}</dt><dd>{new Date(detailResult.value.createdAt).toLocaleString(lang)}</dd>
                <dt>{t.actor}</dt><dd>{detailResult.value.creatorEmail ?? detailResult.value.createdBy}</dd>
              </dl>
              <p className="muted">{t.ownerLastHint}</p>
            </Card>
            {canAdminister ? <InviteForm lang={lang} workspaceId={workspaceId} /> : null}
          </div>
          <Card>
            <h2>{t.members}</h2>
            <form className="row-actions" method="get" action={'/admin/' + lang + '/organizations/' + encodeURIComponent(workspaceId)}>
              <label className="field"><span>{t.role}</span>
                <select name="role" defaultValue={roleFilter}>
                  <option value="">{t.all}</option>
                  <option value="OWNER">OWNER</option>
                  <option value="ADMIN">ADMIN</option>
                  <option value="MEMBER">MEMBER</option>
                </select>
              </label>
              <label className="field"><span>{t.status}</span>
                <select name="status" defaultValue={statusFilter}>
                  <option value="">{t.all}</option>
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="INVITED">INVITED</option>
                  <option value="REVOKED">REVOKED</option>
                  <option value="DECLINED">DECLINED</option>
                </select>
              </label>
              <button className="button secondary" type="submit">{t.filter}</button>
            </form>
            {membersResult && !membersResult.ok ? <Notice tone="warning" title={t.apiUnavailable}>{t.apiCode + ': ' + membersResult.code}</Notice> : null}
            {membersResult && membersResult.ok ? (
              membersResult.value.items.length === 0 ? <Empty>{t.noResults}</Empty> : (
                <div className="table-wrap"><table>
                  <thead><tr><th>{t.emailLabel}</th><th>{t.role}</th><th>{t.membershipStatus}</th><th>{t.joinedAt}</th><th>{canAdminister ? t.action : ''}</th></tr></thead>
                  <tbody>
                    {membersResult.value.items.map((member: MemberView) => (
                      <tr key={member.membershipId}>
                        <td>{member.email}{member.userDisabledAt ? <><br /><Badge tone="warning">{t.suspended}</Badge></> : null}</td>
                        <td>{member.role}</td>
                        <td><Badge tone={member.status === 'ACTIVE' ? 'success' : member.status === 'INVITED' ? 'warning' : 'neutral'}>{member.status}</Badge></td>
                        <td>{member.joinedAt ? new Date(member.joinedAt).toLocaleDateString(lang) : '—'}</td>
                        <td>
                          {canAdminister ? (
                            <div className="stack">
                              <form className="inline-form" action={changeRoleAction}>
                                <input type="hidden" name="lang" value={lang} />
                                <input type="hidden" name="workspaceId" value={workspaceId} />
                                <input type="hidden" name="membershipId" value={member.membershipId} />
                                <label className="field"><span>{t.changeRole}</span>
                                  <select name="role" defaultValue={member.role}>
                                    <option value="OWNER">OWNER</option>
                                    <option value="ADMIN">ADMIN</option>
                                    <option value="MEMBER">MEMBER</option>
                                  </select>
                                </label>
                                <label className="field"><span>{t.justification}</span><input name="reason" required minLength={10} maxLength={500} /></label>
                                <button className="button secondary" type="submit">{t.updateRole}</button>
                              </form>
                              <form className="inline-form" action={revokeMembershipAction}>
                                <input type="hidden" name="lang" value={lang} />
                                <input type="hidden" name="workspaceId" value={workspaceId} />
                                <input type="hidden" name="membershipId" value={member.membershipId} />
                                <label className="field"><span>{t.revokeAccess}</span><input name="reason" required minLength={10} maxLength={500} /></label>
                                <button className="button danger" type="submit">{t.revokeAccess}</button>
                              </form>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )
            ) : null}
            <p className="muted">{t.ownerLastHint}</p>
          </Card>
        </>
      ) : null}
    </Shell>
  );
}
