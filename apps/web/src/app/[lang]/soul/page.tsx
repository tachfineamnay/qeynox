import Link from 'next/link';
import { AppShell, Card, Feedback } from '../../../components/ui';
import { SoulOnboarding, type SoulConsent, type SoulFact, type SoulOnboardingViewData } from '../../../components/soul';
import { api, ApiError, session } from '../../../lib/api';
import { copy, locale, soulCopy } from '../../../lib/copy';

export const dynamic = 'force-dynamic';

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ error?: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const c = soulCopy[lang];
  const error = typeof (await searchParams).error === 'string' ? (await searchParams).error : undefined;
  const current = await session();
  let view: SoulOnboardingViewData | null = null;
  let facts: readonly SoulFact[] = [];
  let consents: readonly SoulConsent[] = [];
  let failure = '';
  if (current) {
    try { view = await api('/v1/soul/onboarding') as SoulOnboardingViewData; }
    catch (error) { failure = error instanceof ApiError ? error.code : 'UNAVAILABLE'; }
    try { facts = await api('/v1/soul/context') as SoulFact[]; } catch { facts = []; }
    try { consents = await api('/v1/soul/consents') as SoulConsent[]; } catch { consents = []; }
  }
  return (
    <AppShell lang={lang} active="soul">
      <header className="page-intro"><p className="eyebrow">{t.eyebrow}</p><h1>{c.title}</h1><p className="muted">{c.intro}</p></header>
      {error ? <Feedback title={c.error} error>{error}</Feedback> : null}
      {!current ? (
        <Card><h2>{c.title}</h2><p>{t.signInRequired}</p><p><Link href={'/' + lang + '/account'}>{t.signin}</Link></p></Card>
      ) : (
        <SoulOnboarding lang={lang} view={view} facts={facts} consents={consents} failure={failure} />
      )}
    </AppShell>
  );
}
