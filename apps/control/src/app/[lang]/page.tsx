import Link from 'next/link';
import { requirePlatformMe, tryApi } from '../../lib/api';
import { copy, locale } from '../../lib/copy';
import { can, CONSULTATION, LIFECYCLE_READ, READ_ORGANIZATIONS, READ_USERS } from '../../lib/permissions';
import { ApiErrorNotice, Badge, Card, Notice, PageHeader, permissionLabels, Shell } from '../../components/shell';
import type { AuditEntryView, CapabilitiesView } from '../../lib/types';

export default async function DashboardPage({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const auditResult = can(me.permissions, CONSULTATION) ? await tryApi<AuditEntryView[]>('/v1/platform/audit?limit=8') : null;
  const capabilitiesResult = can(me.permissions, LIFECYCLE_READ) ? await tryApi<CapabilitiesView>('/v1/platform/users/capabilities') : null;
  const links = [
    { allowed: can(me.permissions, READ_USERS), href: '/' + lang + '/users', label: t.navUsers, intro: t.usersIntro },
    { allowed: can(me.permissions, READ_ORGANIZATIONS), href: '/' + lang + '/organizations', label: t.navOrganizations, intro: t.organizationsIntro },
    { allowed: can(me.permissions, CONSULTATION), href: '/' + lang + '/audit', label: t.navAudit, intro: t.auditIntro },
  ].filter(link => link.allowed);

  return (
    <Shell lang={lang} path="" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <section className="hero">
        <p className="eyebrow">{t.brandCaption}</p>
        <h1>{t.dashboardTitle}</h1>
        <p className="muted">{t.dashboardIntro}</p>
      </section>
      <div className="grid">
        <Card>
          <PageHeader title={t.navAccount} />
          <dl className="kv">
            <dt>{'User'}</dt><dd>{me.userId}</dd>
            <dt>{t.roles}</dt><dd>{me.roles.join(' · ')}</dd>
            <dt>{t.permissions}</dt><dd>{permissionLabels(lang, me.permissions)}</dd>
            <dt>{t.sessionExpires}</dt><dd>{new Date(me.sessionExpiresAt).toLocaleString(lang)}</dd>
          </dl>
        </Card>
        <Card>
          <h2>{t.quickLinks}</h2>
          {links.length === 0 ? <p className="empty">{t.permissionDenied}</p> : (
            <ul className="link-list">
              {links.map(link => (
                <li key={link.href}><Link href={link.href}>{link.label}</Link><p className="muted">{link.intro}</p></li>
              ))}
            </ul>
          )}
        </Card>
        {capabilitiesResult ? (
          <Card>
            <h2>{t.lifecycleCapabilities}</h2>
            {capabilitiesResult.ok ? (
              <>
                <p><strong>{t.emailTransport + ': '}</strong><Badge tone="warning">{capabilitiesResult.value.emailTransport === 'CONFIGURED' ? t.active : t.notConfigured}</Badge></p>
                <ul className="plain-list">
                  {capabilitiesResult.value.features.map(feature => (
                    <li key={feature.feature}>
                      <span>{feature.feature}</span>{' '}
                      <Badge tone={feature.status === 'BLOCKED' ? 'warning' : 'success'}>{feature.status}</Badge>{' '}
                      <span className="muted">{feature.reason}</span>
                    </li>
                  ))}
                </ul>
                <p className="muted">{capabilitiesResult.value.note}</p>
              </>
            ) : <ApiErrorNotice lang={lang} code={capabilitiesResult.code} />}
          </Card>
        ) : null}
      </div>
      {auditResult ? (
        <Card>
          <h2>{t.recentAudit}</h2>
          {auditResult.ok ? (
            auditResult.value.length === 0 ? <p className="empty">{t.noResults}</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>{t.date}</th><th>{t.action}</th><th>{t.actor}</th><th>{t.result}</th><th>{t.target}</th></tr></thead>
                <tbody>
                  {auditResult.value.map(entry => (
                    <tr key={entry.id}>
                      <td>{new Date(entry.happenedAt).toLocaleString(lang)}</td>
                      <td>{entry.action}</td>
                      <td>{entry.actorUserId ?? '—'}</td>
                      <td><Badge tone={entry.outcome === 'SUCCESS' ? 'success' : entry.outcome === 'DENIED' ? 'warning' : 'danger'}>{entry.outcome}</Badge></td>
                      <td>{entry.targetType + (entry.targetId ? ' · ' + entry.targetId : '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )
          ) : <ApiErrorNotice lang={lang} code={auditResult.code} />}
          <p className="pager"><Link href={'/' + lang + '/audit'}>{t.navAudit}</Link></p>
        </Card>
      ) : null}
      <p className="muted">{t.destructiveHint}</p>
    </Shell>
  );
}