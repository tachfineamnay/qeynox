import Link from 'next/link';
import { requirePlatformMe } from '../../../../../lib/api';
import { tryApi } from '../../../../../lib/api';
import { copy, locale } from '../../../../../lib/copy';
import { can, SUPPORT } from '../../../../../lib/permissions';
import { replySupportAction, updateSupportStatusAction } from '../../../../../lib/support-actions';
import { Badge, Card, Empty, Notice, OutcomeNotice, PageHeader, PermissionDenied, Shell } from '../../../../../components/shell';
import type { PlatformSupportConversationDetailView } from '../../../../../lib/types';

export default async function SupportDetailPage({ params, searchParams }: { params: Promise<{ lang: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const resolved = await params;
  const lang = locale(resolved.lang);
  const t = copy[lang];
  const query = await searchParams;
  const me = await requirePlatformMe(lang);
  const allowed = can(me.permissions, SUPPORT);
  const result = allowed ? await tryApi<PlatformSupportConversationDetailView>('/v1/platform/support/conversations/' + encodeURIComponent(resolved.id)) : null;
  const done = typeof query.done === 'string' ? query.done : undefined;
  const error = typeof query.error === 'string' ? query.error : undefined;
  return (
    <Shell lang={lang} path="/support" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <p className="pager"><Link href={'/admin/' + lang + '/support'}>{t.supportBack}</Link></p>
      {!allowed ? <PermissionDenied lang={lang} /> : null}
      <OutcomeNotice lang={lang} done={done} error={error} />
      {result && !result.ok ? <Notice tone="warning" title={t.apiUnavailable}>{t.apiCode + ': ' + result.code}</Notice> : null}
      {result && result.ok ? (
        <>
          <PageHeader
            title={'#' + result.value.conversation.id}
            intro={result.value.conversation.contact.name ?? result.value.conversation.contact.email ?? t.supportTitle}
            actions={<><Badge tone={result.value.conversation.status === 'resolved' ? 'success' : result.value.conversation.status === 'pending' ? 'warning' : 'neutral'}>{result.value.conversation.status}</Badge>{result.value.conversation.priority ? <Badge tone="warning">{result.value.conversation.priority}</Badge> : null}</>}
          />
          <div className="grid">
            <Card>
              <h2>{t.supportQeynox}</h2>
              {result.value.qeynox ? (
                <dl className="kv">
                  <dt>{'User'}</dt><dd><code>{result.value.qeynox.userId}</code></dd>
                  <dt>{t.workspace}</dt><dd><code>{result.value.qeynox.workspaceId}</code></dd>
                </dl>
              ) : <p className="muted">{'—'}</p>}
              <p className="muted">{t.supportAuditNote}</p>
            </Card>
            <Card>
              <h2>{t.status}</h2>
              <form action={updateSupportStatusAction} className="inline-form">
                <input type="hidden" name="lang" value={lang} />
                <input type="hidden" name="conversationId" value={result.value.conversation.id} />
                <label className="field"><span>{t.status}</span>
                  <select name="status" defaultValue={result.value.conversation.status === 'pending' ? 'pending' : result.value.conversation.status === 'resolved' ? 'resolved' : 'open'}>
                    <option value="open">open</option>
                    <option value="pending">pending</option>
                    <option value="resolved">resolved</option>
                  </select>
                </label>
                <button className="button secondary" type="submit">{t.supportStatusUpdated}</button>
              </form>
            </Card>
          </div>
          <Card>
            <h2>{t.supportHistory}</h2>
            {result.value.messages.length === 0 ? <Empty>{t.supportNoMessages}</Empty> : (
              <ul className="timeline">
                {result.value.messages.map(message => (
                  <li key={message.id}>
                    <strong>{message.sender?.name ?? (message.messageType === 'outgoing' ? 'QeyNox' : t.supportContact)}</strong>{' '}
                    <Badge tone={message.messageType === 'outgoing' ? 'success' : 'neutral'}>{message.messageType}</Badge>
                    <small>{new Date(message.createdAt).toLocaleString(lang)}</small>
                    <p>{message.content}</p>
                  </li>
                ))}
              </ul>
            )}
            <form action={replySupportAction}>
              <input type="hidden" name="lang" value={lang} />
              <input type="hidden" name="conversationId" value={result.value.conversation.id} />
              <label className="field"><span>{t.supportReply}</span><textarea name="content" minLength={2} maxLength={5000} rows={3} required /></label>
              <button className="button" type="submit">{t.supportReplySend}</button>
            </form>
          </Card>
        </>
      ) : null}
    </Shell>
  );
}
