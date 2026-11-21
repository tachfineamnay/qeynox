import type { Metadata } from 'next';
import Link from 'next/link';
import { AtlasResult, type AtlasDocument } from '../../../../../components/atlas';
import { Card, Feedback, StatusBadge } from '../../../../../components/ui';
import { copy, locale, type Locale } from '../../../../../lib/copy';
import { readSharedResult } from '../../../../../lib/results';
import { resultsCopy } from '../../../../../lib/results-copy';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

function stamp(lang: Locale, value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return (
    new Intl.DateTimeFormat(lang, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(date) + ' UTC'
  );
}

export default async function SharedAtlasResultPage({
  params,
}: {
  params: Promise<{ lang: string; token: string }>;
}) {
  const p = await params;
  const lang = locale(p.lang);
  const t = copy[lang];
  const r = resultsCopy[lang];
  const encodedToken = encodeURIComponent(p.token);

  const configured = Boolean(process.env.QEYNOX_API_URL);
  const outcome = configured ? await readSharedResult(p.token) : { code: 'NOT_CONFIGURED' };

  const atlasDoc: AtlasDocument | null = outcome.data
    ? {
        id: outcome.data.document.id,
        operationId: 'shared',
        version: outcome.data.document.version,
        title: outcome.data.document.title,
        objective: outcome.data.document.objective,
        status: outcome.data.document.status,
        scope: outcome.data.document.scope,
        findings: outcome.data.document.findings,
        nextActions: outcome.data.document.nextActions,
        limitations: outcome.data.document.limitations,
        unresolved: outcome.data.document.unresolved,
        citations: outcome.data.document.citations,
        createdAt: outcome.data.document.createdAt,
        reviewedAt: outcome.data.document.reviewedAt ?? undefined,
        priorId: outcome.data.document.hasPriorVersion ? 'prior' : undefined,
        interpretations: outcome.data.document.interpretations,
        businessPack: outcome.data.document.businessPack,
      }
    : null;

  return (
    <div className="public-shell">
      <header className="public-header">
        <div className="public-header-inner">
          <Link className="public-brand" href={`/${lang}`}>
            <span className="mark">Q</span>
            <span>
              QeyNox
              <small>Results as a Service</small>
            </span>
          </Link>
          <div className="public-actions" style={{ marginLeft: 'auto', display: 'flex' }}>
            <Link
              className="public-lang"
              href={`/en/results/shared/${encodedToken}`}
              lang="en"
              aria-current={lang === 'en' ? 'true' : undefined}
            >
              EN
            </Link>
            <Link
              className="public-lang"
              href={`/fr/results/shared/${encodedToken}`}
              lang="fr"
              aria-current={lang === 'fr' ? 'true' : undefined}
            >
              FR
            </Link>
          </div>
        </div>
      </header>

      <main className="public-main">
        <div className="public-container qx-shared-container">
          {!configured ? (
            <Card>
              <Feedback title={t.notConfigured} error />
            </Card>
          ) : !outcome.data || !atlasDoc ? (
            <Card>
              {outcome.code === 'DENIED' ? (
                <Feedback title={r.sharedRevokedOrExpiredTitle} error>
                  {r.sharedRevokedOrExpiredBody}
                </Feedback>
              ) : (
                <Feedback title={`${r.sharedNotFoundTitle} (${outcome.code})`} error>
                  {r.sharedNotFoundBody}
                </Feedback>
              )}
            </Card>
          ) : (
            <>
              <Card className="qx-shared-banner">
                <p className="eyebrow">{r.sharedEyebrow}</p>
                <div className="qx-meta-row">
                  <strong>{r.sharedBannerTitle}</strong>
                  <StatusBadge status={outcome.data.document.status} lang={lang} />
                  <span className="badge success">{r.posture[outcome.data.verificationPosture]}</span>
                </div>
                <p className="muted">
                  {outcome.data.share.label
                    ? `${r.sharedLabelPrefix} ${outcome.data.share.label} · `
                    : ''}
                  {r.sharedExpiresPrefix} {stamp(lang, outcome.data.share.expiresAt)}
                </p>
                <p className="muted">{r.sharedReadOnlyNote}</p>
              </Card>

              <AtlasResult doc={atlasDoc} lang={lang} />
            </>
          )}
        </div>
      </main>

      <footer className="public-footer">
        <div className="public-container">
          <p className="public-footer-meta">{t.footer}</p>
        </div>
      </footer>
    </div>
  );
}
