import Link from 'next/link';
import { AppShell, Card, EmptyState, Feedback, PageHeader, SectionHeading, StatusBadge } from '../../../components/ui';
import { copy, locale } from '../../../lib/copy';
import { api, ApiError, session, z } from '../../../lib/api';
import { settingsCopy } from '../../../lib/settings-copy';
import {
  membersPageSchema, overviewSchema, invitationInboxSchema, workspaceListSchema,
  type InvitationInboxItem, type MemberView,
} from '../../../lib/workspaces';
import { CreateWorkspace, InvitationInbox, InvitePanel, MemberRow, Switcher } from '../../../components/team-panels';

export const dynamic = 'force-dynamic';

/**
 * MISSION A18 — workspace self-service: list/create/switch workspaces, then the organization of
 * the active context (stats for OWNER/ADMIN, member directory with role management and revoke).
 */
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ created?: string; create?: string; invite?: string; revoked?: string; role?: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const s = settingsCopy(lang);
  const query = await searchParams;
  const current = await session();
  const configured = Boolean(process.env.QEYNOX_API_URL);

  let workspaces: z.infer<typeof workspaceListSchema>['workspaces'] | null = null;
  let overview: z.infer<typeof overviewSchema> | null = null;
  let members: MemberView[] | null = null;
  let inbox: InvitationInboxItem[] = [];
  let failure = '';
  if (current && configured) {
    try {
      const list = workspaceListSchema.parse(await api('/v1/workspaces'));
      workspaces = list.workspaces;
      overview = overviewSchema.parse(await api('/v1/workspaces/current'));
      if (overview.myRole !== 'MEMBER') {
        members = membersPageSchema.parse(await api('/v1/workspaces/current/members?limit=100')).items;
      }
      inbox = invitationInboxSchema.parse(await api('/v1/invitations')) as unknown as InvitationInboxItem[];
    } catch (error) {
      failure = error instanceof ApiError ? error.code : 'UNAVAILABLE';
    }
  }
  const failureText = failure === 'DENIED' ? t.denied : failure === 'NOT_CONFIGURED' ? t.notConfigured : failure === 'SESSION_REQUIRED' ? t.signInRequired : t.error;
  const canManage = overview !== null && overview.myRole !== 'MEMBER';
  const ownerCount = overview?.stats?.owners ?? 0;
  const membersActive = (members ?? []).filter(m => m.status === 'ACTIVE');

  return (
    <AppShell lang={lang} active="workspaces" path="workspaces">
      <PageHeader eyebrow={t.eyebrow} title={s.workspacesTitle} description={s.workspacesIntro} />

      {query.created === '1' && <Feedback title={s.created_} />}
      {query.create && <Feedback error title={s.failed}>{query.create}</Feedback>}

      {!configured ? <Feedback title={t.notConfigured} /> : !current ? (
        <Feedback title={t.signInRequired}><Link href={'/' + lang + '/account'}>{t.signin} →</Link></Feedback>
      ) : failure ? (
        <Card><Feedback error title={failureText}>{failure}</Feedback></Card>
      ) : (<>
        <InvitationInbox lang={lang} items={inbox} />

        <Card>
          <SectionHeading title={s.yourWorkspaces} />
          {workspaces && workspaces.length > 0 ? <Switcher lang={lang} workspaces={workspaces} currentId={current.workspaceId} /> : <EmptyState title={s.yourWorkspaces} mark="□" />}
        </Card>

        <Card>
          <SectionHeading title={s.newWorkspace} />
          <CreateWorkspace lang={lang} />
        </Card>

        {overview ? (
          <Card>
            <SectionHeading title={s.orgTitle} note={s.orgCreated + ' ' + new Intl.DateTimeFormat(lang, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(overview.createdAt))} />
            <p><strong>{overview.name}</strong> · {s.myRole}: {overview.myRole === 'OWNER' ? s.roleOwner : overview.myRole === 'ADMIN' ? s.roleAdmin : s.roleMember}</p>
            {overview.stats ? (
              <dl className="qx-connection-meta">
                <div><dt>{s.members}</dt><dd>{overview.stats.activeMembers}</dd></div>
                <div><dt>{s.ownersLabel}</dt><dd>{overview.stats.owners}</dd></div>
                <div><dt>{s.adminsLabel}</dt><dd>{overview.stats.admins}</dd></div>
                <div><dt>{s.invitedLabel}</dt><dd>{overview.stats.invited}</dd></div>
              </dl>
            ) : <p className="muted">{s.memberReadOnly}</p>}
          </Card>
        ) : null}

        {members ? (
          <Card>
            <SectionHeading title={s.members} note={s.teamNote} />
            <p className="muted">{members.length} · {canManage ? '' : s.memberReadOnly}</p>
            <ul className="qx-connection-grid">
              {members.map(member => (
                <MemberRow
                  key={member.membershipId}
                  lang={lang}
                  member={member}
                  canManage={canManage}
                  isLastOwner={member.role === 'OWNER' && member.status === 'ACTIVE' && ownerCount === 1}
                  ownerCount={ownerCount}
                />
              ))}
            </ul>
          </Card>
        ) : !canManage ? (
          <Card><Feedback title={s.memberReadOnly} /></Card>
        ) : null}

        {canManage ? (
          <Card>
            <SectionHeading title={s.inviteTitle} note={s.inviteNote} />
            <InvitePanel lang={lang} />
          </Card>
        ) : null}
      </>)}
    </AppShell>
  );
}

