import { AppShell, Card } from '../../../../components/ui';
import { RecoveryRequestForm } from '../../../../components/forms';
import { copy, locale } from '../../../../lib/copy';

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang); const t = copy[lang];
  return <AppShell lang={lang} active="account"><h1>{t.resetRequestTitle}</h1><Card>
    {process.env.QEYNOX_API_URL ? <RecoveryRequestForm lang={lang}/> : <p className="muted">{t.notConfigured}</p>}
  </Card></AppShell>;
}
