import Link from 'next/link';
import { requirePlatformMe, tryApi } from '../../../lib/api';
import { assignPlatformRoleAction, revokePlatformRoleAction } from '../../../lib/actions';
import { copy, locale } from '../../../lib/copy';
import { ADMINISTRATION, can, READ_ASSIGNMENTS } from '../../../lib/permissions';
import { ApiErrorNotice, Badge, Card, Empty, OutcomeNotice, PageHeader, PermissionDenied, Shell } from '../../../components/shell';
import type { PlatformAssignmentView } from '../../../lib/types';

const roles = ['PLATFORM_ADMIN', 'SUPPORT', 'OPERATIONS', 'AUDITOR'] as const;

export default async function AdminsPage({ params, searchParams }: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const lang = locale((await params).lang);
  const query = await searchParams;
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const allowed = can(me.permissions, READ_ASSIGNMENTS);
  const canManage = can(me.permissions, ADMINISTRATION);
  const result = allowed ? await tryApi<PlatformAssignmentView[]>('/v1/platform/admins') : null;
  const done = typeof query.done === 'string' ? query.done : undefined;
  const error = typeof query.error === 'string' ? query.error : undefined;
  const active = result && result.ok ? result.value.filter(item => item.status === 'ACTIVE') : [];
  const revoked = result && result.ok ? result.value.filter(item => item.status !== 'ACTIVE') : [];
  const roleDescription: Record<(typeof roles)[number], string> = {
    PLATFORM_ADMIN: t.roleAdminDesc,
    SUPPORT: t.roleSupportDesc,
    OPERATIONS: t.roleOperationsDesc,
    AUDITOR: t.roleAuditorDesc,
  };

  return (
    <Shell lang={lang} path="/admins" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <PageHeader
        title={t.adminsTitle}
        intro={t.adminsIntro}
        actions={me.roles.map(role => <Badge key={role} tone="neutral">{role}</Badge>)}
      />
      <OutcomeNotice lang={lang} done={done} error={error} />
      {!allowed ? <PermissionDenied lang={lang} /> : null}
      {result && !result.ok ? <ApiErrorNotice lang={lang} code={result.code} /> : null}

      {allowed ? (
        <>
      <Card>
        <h2>{t.platformRole}</h2>
        <p className="muted">{t.roleSeparation}</p>
        <ul className="plain-list">
          {roles.map(role => (
            <li key={role}><code>{role}</code> — {roleDescription[role]}</li>
          ))}
        </ul>
      </Card>

      {canManage ? (
        <Card>
          <h2>{t.assignRole}</h2>
          <p className="muted">{t.assignHint}</p>
          <form className="form" action={assignPlatformRoleAction}>
            <input type="hidden" name="lang" value={lang} />
            <label className="field"><span>{t.targetUserId}</span><input name="userId" required minLength={4} maxLength={120} pattern="[A-Za-z0-9_-]{4,120}" autoComplete="off" /></label>
            <label className="field"><span>{t.platformRole}</span>
              <select name="role" defaultValue="SUPPORT" required>
                {roles.map(role => <option key={role} value={role}>{role}</option>)}
              </select>
            </label>
            <label className="field"><span>{t.grantReason}</span><textarea name="reason" required minLength={10} maxLength={500} rows={3} /></label>
            <button className="button" type="submit">{t.assignRole}</button>
          </form>
        </Card>
      ) : null}

      <Card>
        <h2>{t.roleAssignments}</h2>
        {result && result.ok ? (
          active.length === 0 ? <Empty>{t.assignmentsEmpty}</Empty> : (
            <ul className="assignment-list">
              {active.map(assignment => (
                <li key={assignment.id}>
                  <div className="assignment-head">
                    <code>{assignment.userId}</code>
                    <Badge tone={assignment.role === 'PLATFORM_ADMIN' ? 'warning' : 'neutral'}>{assignment.role}</Badge>
                    <Badge tone="success">{assignment.status}</Badge>
                  </div>
                  <p className="muted">{t.grantedBy}: {assignment.grantedBy} · {new Date(assignment.grantedAt).toLocaleString(lang)}</p>
                  <p>{t.grantReason}: {assignment.grantReason}</p>
                  {canManage ? (
                    <form className="inline-form" action={revokePlatformRoleAction}>
                      <input type="hidden" name="lang" value={lang} />
                      <input type="hidden" name="userId" value={assignment.userId} />
                      <input type="hidden" name="role" value={assignment.role} />
                      <label className="field"><span>{t.revokeReason}</span><input name="reason" required minLength={10} maxLength={500} /></label>
                      <button className="button danger" type="submit">{t.revoke}</button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
        {revoked.length > 0 ? (
          <details>
            <summary>{t.roleHistory} ({revoked.length})</summary>
            <ul className="assignment-list">
              {revoked.map(assignment => (
                <li key={assignment.id}>
                  <div className="assignment-head">
                    <code>{assignment.userId}</code>
                    <Badge tone="neutral">{assignment.role}</Badge>
                    <Badge tone="neutral">{assignment.status}</Badge>
                  </div>
                  <p className="muted">{t.revokedBy}: {assignment.revokedBy ?? '—'} · {t.revokedOn}: {assignment.revokedAt ? new Date(assignment.revokedAt).toLocaleString(lang) : '—'}</p>
                  <p>{t.revokeReason}: {assignment.revokeReason ?? '—'}</p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <p className="pager"><Link href={'/' + lang + '/audit'}>{t.navAudit}</Link></p>
      </Card>
        </>
      ) : null}
    </Shell>
  );
}
