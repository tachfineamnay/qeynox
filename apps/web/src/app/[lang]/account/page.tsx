import { AppShell, Card, Feedback, StatusBadge } from '../../../components/ui';
import { LoginForm, ResendVerification } from '../../../components/forms';
import { copy, locale } from '../../../lib/copy';
import { api, identityStateSchema, session } from '../../../lib/api';
import { logout } from '../../../lib/actions';

/**
 * Account page.
 *
 * When signed in it reports the account's real e-mail verification state and the deployment's
 * actual e-mail delivery capability, so a customer is never told to "check your inbox" on a
 * deployment with no transport. Workspace switching and platform-administration separation are
 * untouched: this page adds states, it does not add authority.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ revocation?: string; reset?: string }> }) {
  const lang = locale((await params).lang); const t = copy[lang]; const current = await session();
  const query = await searchParams;

  let identity: { verified: boolean; delivery: 'CONFIGURED' | 'NOT_CONFIGURED' } | null = null;
  if (current && process.env.QEYNOX_API_URL) {
    try { identity = identityStateSchema.parse(await api('/v1/identity/state')); }
    catch { identity = null; /* an unavailable state must not block sign-out or workspace access */ }
  }

  return <AppShell lang={lang} active="account"><h1>{t.account}</h1>
    <Card><h2>{t.login}</h2>
      {query.revocation === 'unconfirmed' && <Feedback title={t.signoutUnconfirmed}/>}
      {query.reset === 'confirmed' && <Feedback title={t.resetDone}/>}
      {current ? <>
        {identity && <>
          <p><StatusBadge status={identity.verified ? 'VERIFIED' : 'UNVERIFIED'} lang={lang}/> {identity.verified ? t.verificationConfirmed : t.verificationPending}</p>
          {!identity.verified && (identity.delivery === 'CONFIGURED'
            ? <ResendVerification lang={lang}/>
            : <Feedback title={t.deliveryNotConfigured}/>)}
        </>}
        <form action={logout}><input type="hidden" name="locale" value={lang}/><button>{t.signout}</button></form>
      </> : process.env.QEYNOX_API_URL
        ? <><LoginForm lang={lang}/><p className="muted"><a href={'/' + lang + '/account/recover'}>{t.forgotPassword}</a></p><p className="muted"><a href={'/' + lang + '/account/register'}>{t.noAccount}</a></p></>
        : <Feedback title={t.notConfigured}/>}
    </Card>
  </AppShell>;
}
