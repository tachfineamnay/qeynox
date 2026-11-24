import Link from 'next/link';
import { cookies } from 'next/headers';
import { AppShell, Card, Feedback } from '../../../components/ui';
import { SoulOnboarding, type SoulConsent, type SoulFact, type SoulGuidance, type SoulOnboardingViewData } from '../../../components/soul';
import { GUIDANCE_COOKIE } from '../../../lib/soul-guidance-cookie';
import { api, ApiError, session, z } from '../../../lib/api';
import { copy, locale, soulCopy } from '../../../lib/copy';

import type { Metadata } from 'next';

/** MISSION A03 — authenticated product surface: never indexed (robots.txt also disallows it). */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

/**
 * One-shot read of the guidance result the action left behind. A malformed value is discarded
 * silently: nothing is inferred from it and it is never rendered as AI output.
 */
const guidanceSchema = z.object({
  step: z.string(),
  source: z.enum(['AI', 'DETERMINISTIC_FALLBACK']),
  reason: z.string(),
  aiGenerated: z.boolean(),
  content: z.string().max(4000),
  turns: z.object({ used: z.number().int().nonnegative(), maximum: z.number().int().positive() }),
});

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ error?: string }> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const c = soulCopy[lang];
  const error = typeof (await searchParams).error === 'string' ? (await searchParams).error : undefined;
  const jar = await cookies();
  const rawGuidance = jar.get(GUIDANCE_COOKIE)?.value;
  let guidance: SoulGuidance | null = null;
  if (rawGuidance) {
    try { const parsed = guidanceSchema.safeParse(JSON.parse(rawGuidance)); guidance = parsed.success ? parsed.data : null; }
    catch { guidance = null; }
  }
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
        <SoulOnboarding lang={lang} view={view} facts={facts} consents={consents} failure={failure} guidance={guidance} />
      )}
    </AppShell>
  );
}
