import { AppShell, Card } from '../../../../components/ui';
import { RecoveryRequestForm } from '../../../../components/forms';
import { copy, locale } from '../../../../lib/copy';

import type { Metadata } from 'next';

/** MISSION A03 — authenticated product surface: never indexed (robots.txt also disallows it). */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const lang = locale((await params).lang); const t = copy[lang];
  return <AppShell lang={lang} active="account"><h1>{t.resetRequestTitle}</h1><Card>
    {process.env.QEYNOX_API_URL ? <RecoveryRequestForm lang={lang}/> : <p className="muted">{t.notConfigured}</p>}
  </Card></AppShell>;
}
