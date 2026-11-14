import Link from 'next/link';
import { loginAction } from '../../../lib/actions';
import { readSession, tryApi } from '../../../lib/api';
import { copy, locale } from '../../../lib/copy';
import { Card, Notice, OutcomeNotice, PageHeader, Shell } from '../../../components/shell';
import type { PlatformMeView } from '../../../lib/types';

export default async function AccountPage({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lang = locale((await params).lang);
  const query = await searchParams;
  const t = copy[lang];
  const session = await readSession();
  let me: PlatformMeView | null = null;
  if (session) {
    const result = await tryApi<PlatformMeView>('/v1/platform/auth/me');
    if (result.ok) me = result.value;
  }
  if (session && me) {
    return (
      <Shell lang={lang} path="/account" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
        <PageHeader title={t.navAccount} />
        <Card>
          <dl className="kv">
            <dt>{'User'}</dt><dd>{me.userId}</dd>
            <dt>{t.roles}</dt><dd>{me.roles.join(' · ')}</dd>
            <dt>{t.permissions}</dt><dd>{me.permissions.join(' · ')}</dd>
            <dt>{t.sessionExpires}</dt><dd>{new Date(me.sessionExpiresAt).toLocaleString(lang)}</dd>
          </dl>
          <p className="row-actions"><Link className="button secondary" href={'/' + lang}>{t.backToDashboard}</Link></p>
        </Card>
        <Notice tone="info" title={t.navAccount}>{t.signInIntro}</Notice>
      </Shell>
    );
  }
  const expired = query.expired !== undefined;
  const signedOut = query.signout !== undefined;
  const error = typeof query.error === 'string' ? query.error : undefined;
  return (
    <Shell lang={lang} path="/account" permissions={[]}>
      <PageHeader title={t.signIn} intro={t.signInIntro} />
      {expired ? <Notice tone="warning" title={t.sessionExpired} /> : null}
      {signedOut ? <Notice tone="success" title={t.signOut} /> : null}
      <OutcomeNotice lang={lang} error={error} />
      <form action={loginAction} className="card form" method="post">
        <input type="hidden" name="lang" value={lang} />
        <label className="field"><span>{t.email}</span><input name="email" type="email" required autoComplete="username" /></label>
        <label className="field"><span>{t.password}</span><input name="password" type="password" required autoComplete="current-password" /></label>
        <button className="button" type="submit">{t.signIn}</button>
      </form>
      <p className="muted">{t.signInIntro}</p>
    </Shell>
  );
}
