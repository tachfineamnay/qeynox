import Link from 'next/link';
import { AppShell, Card, EmptyState, Feedback, PageHeader, SectionHeading } from '../../../components/ui';
import { copy, locale } from '../../../lib/copy';
import { api, ApiError, session, z } from '../../../lib/api';
import { notificationCopy } from '../../../lib/notification-copy';
import { inboxPageSchema, notificationPreferencesSchema, type InboxPage, type NotificationPreference } from '../../../lib/notifications';
import { MarkAllReadButton, MarkReadButton, PreferencesPanel, fmtDate } from '../../../components/notification-panels';

import type { Metadata } from 'next';

/** MISSION A03 — authenticated product surface: never indexed (robots.txt also disallows it). */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

/**
 * MISSION A19 — notification inbox and e-mail preferences for the signed-in workspace.
 *
 * The inbox is scoped to (account, current workspace) like every tenant surface. It shows what the
 * server recorded — nothing is synthesized client-side, and unread status is the server's truth.
 * Degrades honestly to an error card when the API or the session is unavailable.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ filter?: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const s = notificationCopy(lang);
  const query = await searchParams;
  const unreadOnly = query.filter === 'unread';
  const current = await session();
  const configured = Boolean(process.env.QEYNOX_API_URL);

  let inbox: InboxPage | null = null;
  let preferences: NotificationPreference[] | null = null;
  let failure = '';
  if (current && configured) {
    try {
      const suffix = (unreadOnly ? '?unreadOnly=true&limit=25' : '?limit=25');
      inbox = inboxPageSchema.parse(await api('/v1/notifications' + suffix));
      preferences = notificationPreferencesSchema.parse(await api('/v1/notifications/preferences'));
    } catch (error) {
      failure = error instanceof ApiError ? error.code : 'UNAVAILABLE';
    }
  }
  const failureText = failure === 'DENIED' ? t.denied : failure === 'NOT_CONFIGURED' ? t.notConfigured : failure === 'SESSION_REQUIRED' ? t.signInRequired : s.failed;

  return (
    <AppShell lang={lang} active="notifications" path="notifications">
      <PageHeader
        eyebrow={t.eyebrow}
        title={s.title}
        description={s.intro}
        aside={inbox && inbox.unreadCount > 0 ? <MarkAllReadButton lang={lang} /> : undefined}
      />
      {!configured ? <Feedback title={t.notConfigured} /> : !current ? (
        <Feedback title={t.signInRequired}><Link href={'/' + lang + '/account'}>{t.signin} →</Link></Feedback>
      ) : failure ? (
        <Card><Feedback error title={failureText}>{failure}</Feedback></Card>
      ) : inbox ? (<>
        <Card>
          <div className="section-heading">
            <SectionHeading title={unreadOnly ? s.filterUnread : s.filterAll} note={inbox.unreadCount > 0 ? `${inbox.unreadCount} ${s.unread}` : undefined} />
            <nav aria-label={s.title} style={{ display: 'flex', gap: 8 }}>
              <Link className="button secondary" aria-current={!unreadOnly ? 'true' : undefined} href={'/' + lang + '/notifications'} style={{ minHeight: 36, padding: '6px 14px', fontSize: 13 }}>{s.filterAll}</Link>
              <Link className="button secondary" aria-current={unreadOnly ? 'true' : undefined} href={'/' + lang + '/notifications?filter=unread'} style={{ minHeight: 36, padding: '6px 14px', fontSize: 13 }}>{s.filterUnread}</Link>
            </nav>
          </div>
          {inbox.items.length === 0 ? (
            <EmptyState title={s.empty} mark="◍">{unreadOnly ? s.emptyUnread : s.emptyAll}</EmptyState>
          ) : (
            <ul className="mission-list">
              {inbox.items.map(item => (
                <li key={item.id} style={item.readAt ? undefined : { background: 'var(--qx-blue-50)' }}>
                  <div>
                    <span className="mission-title">{item.title}</span>
                    <p>{item.body}</p>
                    <p className="muted" style={{ fontSize: 13 }}><time>{fmtDate(lang, item.createdAt)}</time></p>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
                    {item.linkPath ? <Link href={'/' + lang + item.linkPath}>{s.openMission} →</Link> : null}
                    {!item.readAt ? <MarkReadButton lang={lang} id={item.id} /> : <span className="muted" style={{ fontSize: 13 }}>✓</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <SectionHeading title={s.preferencesTitle} note={s.preferencesNote} />
          {preferences ? <PreferencesPanel lang={lang} initial={preferences} /> : null}
        </Card>
      </>) : null}
    </AppShell>
  );
}
