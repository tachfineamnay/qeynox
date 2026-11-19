import { AppShell, Card, Feedback } from '../../../../components/ui';
import { RegisterForm } from '../../../../components/forms';
import { copy, locale } from '../../../../lib/copy';
import { session } from '../../../../lib/api';

/**
 * Self-service registration. Rendered only when the API connection AND the deployment's explicit
 * registration switch are both present: the form must not appear when the API would refuse it.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang); const t = copy[lang]; const current = await session();
  const enabled = Boolean(process.env.QEYNOX_API_URL) && process.env.QEYNOX_REGISTRATION_ENABLED !== 'false';
  return <AppShell lang={lang} active="account"><h1>{t.createAccount}</h1><Card>
    {current ? <Feedback title={t.login}><a href={'/' + lang + '/mydash'}>{t.dash}</a></Feedback>
      : enabled ? <RegisterForm lang={lang}/> : <Feedback title={t.notConfigured}/>}
  </Card></AppShell>;
}
