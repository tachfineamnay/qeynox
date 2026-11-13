import { AppShell, Card, Feedback } from '../../../components/ui';
import { LoginForm } from '../../../components/forms';
import { copy, locale } from '../../../lib/copy';
import { session } from '../../../lib/api';
import { logout } from '../../../lib/actions';
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ revocation?: string }> }) {
  const lang = locale((await params).lang); const t = copy[lang]; const current = await session();
  return <AppShell lang={lang} active="account"><h1>{t.account}</h1><Card><h2>{t.login}</h2>{(await searchParams).revocation === 'unconfirmed' && <Feedback title={t.signoutUnconfirmed}/>} {current ? <form action={logout}><input type="hidden" name="locale" value={lang}/><button>{t.signout}</button></form> : process.env.QEYNOX_API_URL ? <LoginForm lang={lang}/> : <Feedback title={t.notConfigured}/>}</Card></AppShell>;
}
