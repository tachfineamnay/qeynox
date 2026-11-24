import Link from 'next/link';
import { AppShell, Card, Feedback, PageHeader, SectionHeading, StatusBadge } from '../../../../components/ui';
import { copy, locale } from '../../../../lib/copy';
import { api, ApiError, session, z } from '../../../../lib/api';
import { settingsCopy } from '../../../../lib/settings-copy';
import { profileSchema, sessionViewSchema, deletionRequestSchema } from '../../../../lib/workspaces';
import { PasswordForm, SessionList, LocaleForm, DeletionPanel } from '../../../../components/account-panels';

import type { Metadata } from 'next';

/** MISSION A03 — authenticated product surface: never indexed (robots.txt also disallows it). */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

/**
 * MISSION A18 — account settings: profile, security (password + active sessions), privacy summary
 * and the account-deletion request flow. Every panel degrades honestly when the API is unavailable.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ password?: string; deletion?: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const s = settingsCopy(lang);
  const query = await searchParams;
  const current = await session();
  const configured = Boolean(process.env.QEYNOX_API_URL);

  let profile: z.infer<typeof profileSchema> | null = null;
  let sessions: z.infer<typeof sessionViewSchema>[] | null = null;
  let deletion: z.infer<typeof deletionRequestSchema> | null = null;
  let failure = '';
  if (current && configured) {
    try {
      profile = profileSchema.parse(await api('/v1/account/profile'));
      sessions = z.array(sessionViewSchema).parse(await api('/v1/account/sessions'));
      deletion = deletionRequestSchema.nullable().parse(await api('/v1/account/deletion-request'));
    } catch (error) {
      failure = error instanceof ApiError ? error.code : 'UNAVAILABLE';
    }
  }
  const failureText = failure === 'DENIED' ? t.denied : failure === 'NOT_CONFIGURED' ? t.notConfigured : failure === 'SESSION_REQUIRED' ? t.signInRequired : t.error;

  return (
    <AppShell lang={lang} active="account" path="account/settings">
      <PageHeader eyebrow={t.eyebrow} title={s.accountTitle} description={s.profileIntro} />
      {!configured ? <Feedback title={t.notConfigured} /> : !current ? (
        <Feedback title={t.signInRequired}><Link href={'/' + lang + '/account'}>{t.signin} →</Link></Feedback>
      ) : failure ? (
        <Card><Feedback error title={failureText}>{failure}</Feedback></Card>
      ) : profile ? (<>
        <Card>
          <SectionHeading title={s.profileTitle} />
          <dl className="qx-connection-meta">
            <div><dt>{s.email}</dt><dd>{profile.email}</dd></div>
            <div><dt>{s.memberSince}</dt><dd><time>{new Intl.DateTimeFormat(lang, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(profile.createdAt))}</time></dd></div>
            <div><dt>{s.workspaceCount}</dt><dd>{profile.activeWorkspaceCount}</dd></div>
          </dl>
          <p>{profile.verifiedAt
            ? <><StatusBadge status="VERIFIED" lang={lang}/> {s.verified}</>
            : <><StatusBadge status="UNVERIFIED" lang={lang}/> {s.unverified}</>}</p>
          <LocaleForm lang={lang} current={profile.locale} />
        </Card>

        <Card>
          <SectionHeading title={s.securityTitle} note={s.securityIntro} />
          {query.password === 'changed' && <Feedback title={s.passwordChanged} />}
          <PasswordForm lang={lang} />
        </Card>

        <Card>
          <SectionHeading title={s.sessionsTitle} note={s.sessionsIntro} />
          {sessions ? <SessionList lang={lang} sessions={sessions} /> : null}
        </Card>

        <Card>
          <SectionHeading title={s.privacyTitle} note={s.privacyIntro} />
          <Link href={'/' + lang + '/soul'}>{s.manageSoul} →</Link>
        </Card>

        <Card>
          <SectionHeading title={s.dangerTitle} note={s.dangerIntro} />
          {query.deletion === 'requested' && <Feedback title={s.deletionRequested} />}
          {query.deletion === 'cancelled' && <Feedback title={s.deletionCancelled} />}
          <DeletionPanel lang={lang} initial={deletion} />
        </Card>
      </>) : null}
    </AppShell>
  );
}
