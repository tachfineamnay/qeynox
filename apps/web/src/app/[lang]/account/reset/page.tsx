import { AppShell, Card, Feedback } from '../../../../components/ui';
import { RecoveryConfirmForm } from '../../../../components/forms';
import { copy, locale } from '../../../../lib/copy';
import { api, recoveryInspectSchema } from '../../../../lib/api';

/**
 * "Choose a new password" screen. The token is inspected WITHOUT being consumed, so reloading this
 * page cannot burn the link. A dead or already-used link is reported plainly instead of showing a
 * form that would fail on submit.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ token?: string }> }) {
  const lang = locale((await params).lang); const t = copy[lang];
  const token = (await searchParams).token ?? '';
  let valid = false;
  if (token && process.env.QEYNOX_API_URL) {
    try { valid = recoveryInspectSchema.parse(await api('/v1/identity/recovery/inspect?token=' + encodeURIComponent(token), 'GET', undefined, false)).valid; }
    catch { valid = false; }
  }
  return <AppShell lang={lang} active="account"><h1>{t.resetTitle}</h1><Card>
    {valid ? <RecoveryConfirmForm lang={lang} token={token}/>
      : <Feedback title={t.resetLinkDead}><a href={'/' + lang + '/account/recover'}>{t.resetRequest}</a></Feedback>}
  </Card></AppShell>;
}
