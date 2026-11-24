import { AppShell, Card, Feedback } from '../../../../components/ui';
import { VerificationForm } from '../../../../components/forms';
import { copy, locale } from '../../../../lib/copy';
import { api, z } from '../../../../lib/api';

import type { Metadata } from 'next';

/** MISSION A03 — authenticated product surface: never indexed (robots.txt also disallows it). */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Verification landing page.
 *
 * The token is checked before the form is offered, using the same non-consuming inspect route the
 * recovery screen uses. Without this a customer with a dead link would be shown a "Confirm address"
 * button that could only fail — a recovery state must be visible before the action, not after it.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ token?: string }> }) {
  const lang = locale((await params).lang); const t = copy[lang];
  const token = (await searchParams).token ?? '';

  let valid = false;
  if (token && process.env.QEYNOX_API_URL) {
    try {
      const value = z.object({ valid: z.boolean() }).parse(
        await api('/v1/identity/verification/inspect?token=' + encodeURIComponent(token), 'GET', undefined, false),
      );
      valid = value.valid;
    } catch { valid = false; }
  }

  return <AppShell lang={lang} active="account"><h1>{t.verifyTitle}</h1><Card>
    {valid
      ? <VerificationForm lang={lang} token={token}/>
      : <Feedback title={t.verifyLinkDead}><a href={'/' + lang + '/account'}>{t.account}</a></Feedback>}
  </Card></AppShell>;
}
