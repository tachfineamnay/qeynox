import Link from 'next/link';
import { AppShell, Card, Feedback } from '../../../../components/ui';
import { api, ApiError, session } from '../../../../lib/api';
import { copy, locale, supportCopy } from '../../../../lib/copy';
import { replySupportConversation } from '../../../../lib/support-actions';

interface Message { id: string; content: string; messageType: string; private: boolean; createdAt: string; sender: { name: string | null; type: string | null } | null }
interface ConversationDetail { conversation: { id: string; status: string; priority: string | null; contact: { name: string | null; email: string | null } }; messages: readonly Message[] }

export const dynamic = 'force-dynamic';

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string; id: string }>; searchParams: Promise<{ error?: string; done?: string }> }) {
  const resolved = await params;
  const lang = locale(resolved.lang);
  const t = copy[lang];
  const c = supportCopy[lang];
  const query = await searchParams;
  const signedIn = Boolean(await session());
  let detail: ConversationDetail | null = null;
  let failure = '';
  if (signedIn) {
    try { detail = await api('/v1/support/conversations/' + encodeURIComponent(resolved.id)) as ConversationDetail; }
    catch (error) { failure = error instanceof ApiError ? error.code : 'UNAVAILABLE'; }
  }
  return (
    <AppShell lang={lang} active="support">
      <p><Link href={'/' + lang + '/support'}>{'← ' + c.back}</Link></p>
      {query.error ? <Feedback title={c.error} error>{query.error}</Feedback> : null}
      {query.done ? <Feedback title={c.done} /> : null}
      {!signedIn ? <Card><p>{c.signInRequired}</p><p><Link href={'/' + lang + '/account'}>{t.signin}</Link></p></Card> : null}
      {failure ? <Feedback title={c.error} error>{failure}</Feedback> : null}
      {detail ? (
        <>
          <Card>
            <div className="section-heading">
              <h1>{'#' + detail.conversation.id}</h1>
              <span className="badge neutral">{detail.conversation.status}</span>
              {detail.conversation.priority ? <span className="badge warning">{detail.conversation.priority}</span> : null}
            </div>
            <p className="muted">{(detail.conversation.contact.name ?? detail.conversation.contact.email ?? '')}</p>
            <p className="muted">{c.chatwootNote}</p>
          </Card>
          <Card>
            <h2>{c.history}</h2>
            {detail.messages.length === 0 ? <p className="empty">{c.noMessages}</p> : (
              <ul className="event-list">
                {detail.messages.map(message => (
                  <li key={message.id}>
                    <strong>{message.sender?.name ?? (message.messageType === 'outgoing' ? 'QeyNox support' : 'Contact')}</strong>{' '}
                    <small>{new Date(message.createdAt).toLocaleString(lang)}</small>
                    <p>{message.content}</p>
                  </li>
                ))}
              </ul>
            )}
            <form action={replySupportConversation}>
              <input type="hidden" name="locale" value={lang} />
              <input type="hidden" name="conversationId" value={detail.conversation.id} />
              <label htmlFor="content">{c.reply}</label>
              <textarea id="content" name="content" minLength={2} maxLength={5000} rows={3} required />
              <div className="form-bottom"><button>{c.replySend}</button></div>
            </form>
          </Card>
        </>
      ) : null}
    </AppShell>
  );
}
