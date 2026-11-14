import Link from 'next/link';
import type { ReactNode } from 'react';
import { requirePlatformMe, tryApi } from '../../../lib/api';
import { copy, locale } from '../../../lib/copy';
import { can, SUPPORT } from '../../../lib/permissions';
import { Badge, Card, Empty, Notice, PageHeader, PermissionDenied, Shell } from '../../../components/shell';
import type { PlatformSupportConversationView, SupportCapabilityView } from '../../../lib/types';

function first(value: string | string[] | undefined): string { return typeof value === 'string' ? value : ''; }
const statuses = ['open', 'pending', 'resolved', 'snoozed', 'all'] as const;

export default async function SupportPage({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lang = locale((await params).lang);
  const query = await searchParams;
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const allowed = can(me.permissions, SUPPORT);
  const rawStatus = first(query.status);
  const status = (statuses as readonly string[]).includes(rawStatus) ? rawStatus : 'all';
  const statusResult = allowed ? await tryApi<{ capability: SupportCapabilityView; note: string }>('/v1/platform/support/status') : null;
  const capability = statusResult && statusResult.ok ? statusResult.value.capability : null;
  const configured = capability?.status === 'CONFIGURED';
  const listResult = configured ? await tryApi<PlatformSupportConversationView[]>('/v1/platform/support/conversations?status=' + encodeURIComponent(status)) : null;
  let content: ReactNode;
  if (!allowed) content = <PermissionDenied lang={lang} />;
  else if (!statusResult || !statusResult.ok) content = <Notice tone="warning" title={t.apiUnavailable}>{t.apiCode + ': ' + (statusResult && !statusResult.ok ? statusResult.code : 'UNAVAILABLE')}</Notice>;
  else if (statusResult.value.capability.status !== 'CONFIGURED') {
    content = <Card><div className="section-heading"><h2>{t.supportNotConfigured}</h2><Badge tone="warning">{'NOT_CONFIGURED'}</Badge></div><p><strong>{t.supportReason + ': '}</strong><code>{capability?.reason ?? 'CHATWOOT_NOT_CONFIGURED'}</code></p><p className="muted">{t.supportConfigHint}</p></Card>;
  } else if (!listResult || !listResult.ok) content = <Notice tone="warning" title={t.apiUnavailable}>{t.apiCode + ': ' + (listResult && !listResult.ok ? listResult.code : 'UNAVAILABLE')}</Notice>;
  else if (listResult.value.length === 0) content = <Card><Empty>{t.supportEmpty}</Empty></Card>;
  else {
    content = (
      <Card>
        <div className="table-wrap"><table>
          <thead><tr><th>{'#'}</th><th>{t.supportContact}</th><th>{t.status}</th><th>{t.supportPriority}</th><th>{t.supportQeynox}</th><th>{t.supportUpdated}</th><th>{t.supportOpen}</th></tr></thead>
          <tbody>
            {listResult.value.map(view => (
              <tr key={view.conversation.id}>
                <td>{view.conversation.id}</td>
                <td>{view.conversation.contact.name ?? view.conversation.contact.email ?? '—'}</td>
                <td><Badge tone={view.conversation.status === 'resolved' ? 'success' : view.conversation.status === 'pending' ? 'warning' : 'neutral'}>{view.conversation.status}</Badge></td>
                <td>{view.conversation.priority ? <Badge tone="warning">{view.conversation.priority}</Badge> : '—'}</td>
                <td>{view.qeynox ? <code>{view.qeynox.userId}</code> : '—'}</td>
                <td>{view.conversation.lastMessageAt ? new Date(view.conversation.lastMessageAt).toLocaleString(lang) : '—'}</td>
                <td><Link href={'/' + lang + '/support/' + encodeURIComponent(view.conversation.id)}>{t.supportOpen}</Link></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>
    );
  }
  return (
    <Shell lang={lang} path="/support" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <PageHeader title={t.supportTitle} intro={t.supportIntro} actions={<Badge tone={configured ? 'success' : 'warning'}>{configured ? t.supportConfigured : t.supportNotConfigured}</Badge>} />
      {allowed && configured ? (
        <form className="card form" method="get" action={'/admin/' + lang + '/support'}>
          <div className="row-actions">
            <label className="field"><span>{t.status}</span>
              <select name="status" defaultValue={status}>
                <option value="all">{t.supportAll}</option>
                <option value="open">open</option>
                <option value="pending">pending</option>
                <option value="resolved">resolved</option>
                <option value="snoozed">snoozed</option>
              </select>
            </label>
            <button className="button" type="submit">{t.supportFilter}</button>
          </div>
        </form>
      ) : null}
      {content}
      <p className="muted">{t.supportAuditNote}</p>
    </Shell>
  );
}
