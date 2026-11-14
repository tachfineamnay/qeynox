import Link from 'next/link';
import { AppShell, Card, Feedback } from '../../../components/ui';
import { api, ApiError, session } from '../../../lib/api';
import { copy, locale, supportCopy } from '../../../lib/copy';
import { openSupportConversation } from '../../../lib/support-actions';

interface Capability { status: 'CONFIGURED' | 'NOT_CONFIGURED'; reason: string | null; inboxConfigured: boolean }
interface Conversation { id: string; status: string; priority: string | null; lastMessageAt: string | null; contact: { name: string | null; email: string | null } }

export const dynamic = 'force-dynamic';

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ error?: string; done?: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const c = supportCopy[lang];
  const query = await searchParams;
  const signedIn = Boolean(await session());
  let capability: Capability | null = null;
  let conversations: readonly Conversation[] = [];
  let failure = '';
  if (signedIn) {
    try { capability = await api('/v1/support/status') as Capability; } catch (error) { failure = error instanceof ApiError ? error.code : 'UNAVAILABLE'; }
    if (capability?.status === 'CONFIGURED') {
      try { conversations = await api('/v1/support/conversations') as Conversation[]; } catch (error) { failure = error instanceof ApiError ? error.code : 'UNAVAILABLE'; }
    }
  }
  return (
    <AppShell lang={lang} active="support">
      <header className="page-intro"><p className="eyebrow">{t.eyebrow}</p><h1>{c.title}</h1><p className="muted">{c.intro}</p></header>
      {query.error ? <Feedback title={c.error} error>{query.error}</Feedback> : null}
      {query.done ? <Feedback title={c.done} /> : null}
      {failure ? <Feedback title={c.error} error>{failure}</Feedback> : null}
      {!signedIn ? (
        <Card><p>{c.signInRequired}</p><p><Link href={'/' + lang + '/account'}>{t.signin}</Link></p></Card>
      ) : capability === null ? null : capability.status === 'NOT_CONFIGURED' ? (
        <Card>
          <div className="section-heading"><h2>{c.notConfigured}</h2><span className="badge neutral">{'NOT_CONFIGURED'}</span></div>
          <p><strong>{c.configReason}: </strong>{capability.reason ?? 'CHATWOOT_NOT_CONFIGURED'}</p>
          <p className="muted">{c.configHint}</p>
        </Card>
      ) : (
        <>
          <Card>
            <div className="section-heading"><h2>{c.newTitle}</h2><span className="badge success">{'CONFIGURED'}</span></div>
            <form action={openSupportConversation}>
              <input type="hidden" name="locale" value={lang} />
              <label htmlFor="message">{c.message}</label>
              <textarea id="message" name="message" minLength={2} maxLength={5000} rows={4} required />
              <div className="form-bottom"><button>{c.send}</button></div>
            </form>
            <p className="muted">{c.chatwootNote}</p>
          </Card>
          <Card>
            <h2>{c.conversations}</h2>
            {conversations.length === 0 ? <p className="empty">{c.empty}</p> : (
              <ul className="event-list">
                {conversations.map(conversation => (
                  <li key={conversation.id}>
                    <Link href={'/' + lang + '/support/' + encodeURIComponent(conversation.id)}>{'#' + conversation.id}</Link>{' '}
                    <span className={'badge ' + (conversation.status === 'resolved' ? 'success' : conversation.status === 'pending' ? 'warning' : 'neutral')}>{conversation.status}</span>{' '}
                    {conversation.priority ? <span className="badge warning">{conversation.priority}</span> : null}
                    <small>{c.updated + ': ' + (conversation.lastMessageAt ? new Date(conversation.lastMessageAt).toLocaleString(lang) : '—')}</small>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </AppShell>
  );
}
