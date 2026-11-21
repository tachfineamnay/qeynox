import type { Metadata } from 'next';
import { AppShell, Card, Feedback } from '../../../../components/ui';
import { RegisterForm } from '../../../../components/forms';
import { copy, locale } from '../../../../lib/copy';
import { session } from '../../../../lib/api';
import { invitationFromQuery, readRegistrationPolicy } from '../../../../lib/registration';
import { registrationCopy } from '../../../../lib/registration-copy';

// The invitation link carries a single-use token in its query string: never leak it via Referer.
export const metadata: Metadata = { referrer: 'no-referrer' };

/**
 * Self-service registration (MISSION A21.05).
 *
 * The page has no registration switch of its own. It renders exactly what the API's authoritative
 * policy (`GET /v1/auth/registration-policy`) reports, and the API enforces the same resolver on
 * submit. CLOSED, a missing API connection or an unreadable policy all fail closed: no form.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lang = locale((await params).lang); const t = copy[lang]; const r = registrationCopy[lang];
  const current = await session();
  const signIn = <a href={'/' + lang + '/account'}>{r.signIn}</a>;
  if (current) {
    return <AppShell lang={lang} active="account"><h1>{t.createAccount}</h1><Card>
      <Feedback title={t.login}><a href={'/' + lang + '/mydash'}>{t.dash}</a></Feedback>
    </Card></AppShell>;
  }
  const read = await readRegistrationPolicy();
  const invitation = invitationFromQuery((await searchParams).invitation);
  let body;
  if (read.kind === 'NOT_CONFIGURED') body = <Feedback title={t.notConfigured}/>;
  else if (read.kind === 'UNAVAILABLE') body = <Feedback title={r.unavailableTitle} error>{r.unavailableBody}</Feedback>;
  else if (!read.policy.acceptingRegistrations) body = <><Feedback title={r.closedTitle}>{r.closedBody}</Feedback><p>{signIn}</p></>;
  else body = <>
    {read.policy.invitationRequired && <Feedback title={r.inviteOnlyTitle}>{r.inviteOnlyNote}</Feedback>}
    <RegisterForm lang={lang} invitationRequired={read.policy.invitationRequired} invitation={invitation}/>
  </>;
  return <AppShell lang={lang} active="account"><h1>{t.createAccount}</h1><Card><div data-registration-mode={read.kind === 'OK' ? read.policy.mode : read.kind}>{body}</div></Card></AppShell>;
}
