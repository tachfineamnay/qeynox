import Link from 'next/link';
import type { AtlasVerificationPosture } from '@qeynox/contracts';
import {
  AppShell,
  Card,
  EmptyState,
  Feedback,
  PageHeader,
  SectionHeading,
  StatusBadge,
} from '../../../components/ui';
import { session } from '../../../lib/api';
import { copy, locale, type Locale } from '../../../lib/copy';
import { readResultsLibrary } from '../../../lib/results';
import { resultsCopy } from '../../../lib/results-copy';

export const dynamic = 'force-dynamic';

interface ResultsSearchParams {
  q?: string;
  operationId?: string;
  state?: string;
  operationStatus?: string;
  versionScope?: string;
  version?: string;
  from?: string;
  to?: string;
  cursor?: string;
}

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

function postureTone(posture: AtlasVerificationPosture): string {
  if (posture === 'VERIFIED_DELIVERABLE') return 'success';
  if (posture === 'AWAITING_REVIEW') return 'info';
  if (posture === 'PARTIALLY_VERIFIED') return 'warning';
  return 'neutral';
}

function buildLibraryHref(
  lang: Locale,
  filters: Record<string, string | undefined>,
  nextCursor?: string | null,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'cursor') continue;
    if (typeof value === 'string' && value.trim().length > 0) {
      params.set(key, value.trim());
    }
  }
  if (nextCursor) params.set('cursor', nextCursor);
  const query = params.toString();
  return query ? `/${lang}/results?${query}` : `/${lang}/results`;
}

export default async function ResultsLibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<ResultsSearchParams>;
}) {
  const p = await params;
  const query = await searchParams;
  const lang = locale(p.lang);
  const t = copy[lang];
  const r = resultsCopy[lang];

  const configured = Boolean(process.env.QEYNOX_API_URL);
  const signedIn = Boolean(await session());

  const activeFilterParams: Record<string, string | undefined> = {
    q: typeof query.q === 'string' ? query.q : undefined,
    operationId: typeof query.operationId === 'string' ? query.operationId : undefined,
    state: typeof query.state === 'string' ? query.state : undefined,
    operationStatus: typeof query.operationStatus === 'string' ? query.operationStatus : undefined,
    versionScope: typeof query.versionScope === 'string' ? query.versionScope : undefined,
    version: typeof query.version === 'string' ? query.version : undefined,
    from: typeof query.from === 'string' ? query.from : undefined,
    to: typeof query.to === 'string' ? query.to : undefined,
    cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
  };

  const hasUserFilter = Boolean(
    activeFilterParams.q?.trim() ||
      activeFilterParams.operationId?.trim() ||
      activeFilterParams.state?.trim() ||
      activeFilterParams.operationStatus?.trim() ||
      (activeFilterParams.versionScope && activeFilterParams.versionScope !== 'ALL') ||
      activeFilterParams.version?.trim() ||
      activeFilterParams.from?.trim() ||
      activeFilterParams.to?.trim(),
  );

  if (!configured) {
    return (
      <AppShell lang={lang} active="results">
        <PageHeader eyebrow={r.eyebrow} title={r.title} description={r.intro} />
        <Feedback title={t.notConfigured} />
      </AppShell>
    );
  }

  if (!signedIn) {
    return (
      <AppShell lang={lang} active="results">
        <PageHeader eyebrow={r.eyebrow} title={r.title} description={r.intro} />
        <Feedback title={t.signInRequired}>
          <Link href={`/${lang}/account`}>{t.signin} →</Link>
        </Feedback>
      </AppShell>
    );
  }

  const outcome = await readResultsLibrary(activeFilterParams);
  if (!outcome.data) {
    const errorTitle =
      outcome.code === 'DENIED'
        ? t.denied
        : outcome.code === 'NOT_CONFIGURED'
          ? t.notConfigured
          : outcome.code === 'INVALID_INPUT'
            ? r.invalidQueryNotice
            : `${t.error} (${outcome.code})`;
    return (
      <AppShell lang={lang} active="results">
        <PageHeader
          eyebrow={r.eyebrow}
          title={r.title}
          description={r.intro}
          aside={
            <Link className="button secondary" href={`/${lang}/results`}>
              {r.resetFilters}
            </Link>
          }
        />
        <Card>
          <Feedback title={errorTitle} error />
        </Card>
      </AppShell>
    );
  }

  const page = outcome.data;
  const missionsWithResultsCount = page.missions.filter(m => m.documentCount > 0).length;

  return (
    <AppShell lang={lang} active="results">
      <PageHeader
        eyebrow={r.eyebrow}
        title={r.title}
        description={r.intro}
        aside={
          <Link
            className="button secondary"
            href={buildLibraryHref(lang, activeFilterParams, activeFilterParams.cursor)}
          >
            {r.refresh}
          </Link>
        }
      />

      <div className="qx-metrics qx-metrics-four" role="list">
        <div className="qx-metric" role="listitem">
          <span className="qx-metric-value">{page.totalCount}</span>
          <span className="qx-metric-label">{r.metricMatching}</span>
        </div>
        <div className="qx-metric" role="listitem">
          <span className="qx-metric-value">{page.workspaceDocumentCount}</span>
          <span className="qx-metric-label">{r.metricWorkspaceTotal}</span>
        </div>
        <div className="qx-metric" role="listitem">
          <span className="qx-metric-value">{missionsWithResultsCount}</span>
          <span className="qx-metric-label">{r.metricMissionsWithResults}</span>
        </div>
        <div className="qx-metric" role="listitem">
          <span className="qx-metric-value">{page.failedOperations.length}</span>
          <span className="qx-metric-label">{r.metricFailedMissions}</span>
        </div>
      </div>

      {!page.artifactStoreConfigured ? (
        <Card className="qx-storage-banner">
          <p className="muted">{r.storageUnavailableNotice}</p>
        </Card>
      ) : null}

      <Card>
        <SectionHeading title={r.filtersTitle} />
        <form method="GET" action={`/${lang}/results`} className="qx-atlas-filter-form">
          <div className="qx-atlas-filter-search">
            <label htmlFor="atlas-q">{r.searchLabel}</label>
            <input
              id="atlas-q"
              name="q"
              type="search"
              defaultValue={activeFilterParams.q ?? ''}
              maxLength={200}
              placeholder={r.searchPlaceholder}
            />
          </div>

          <div className="qx-atlas-filter-grid">
            <div className="qx-field">
              <label htmlFor="atlas-mission">{r.missionLabel}</label>
              <select
                id="atlas-mission"
                name="operationId"
                defaultValue={activeFilterParams.operationId ?? ''}
              >
                <option value="">{r.allMissions}</option>
                {page.missions.map(mission => (
                  <option key={mission.operationId} value={mission.operationId}>
                    {mission.title} ({mission.documentCount})
                  </option>
                ))}
              </select>
            </div>

            <div className="qx-field">
              <label htmlFor="atlas-state">{r.stateLabel}</label>
              <select id="atlas-state" name="state" defaultValue={activeFilterParams.state ?? ''}>
                <option value="">{r.allStates}</option>
                {(['DELIVERABLE', 'READY_FOR_REVIEW', 'PARTIAL', 'DRAFT'] as const).map(st => (
                  <option key={st} value={st}>
                    {t.statuses[st] ?? st}
                  </option>
                ))}
              </select>
            </div>

            <div className="qx-field">
              <label htmlFor="atlas-op-status">{r.missionStatusLabel}</label>
              <select
                id="atlas-op-status"
                name="operationStatus"
                defaultValue={activeFilterParams.operationStatus ?? ''}
              >
                <option value="">{r.allMissionStatuses}</option>
                {(
                  [
                    'COMPLETED',
                    'WAITING_APPROVAL',
                    'RUNNING',
                    'READY',
                    'DRAFT',
                    'INTERRUPTED',
                    'FAILED',
                    'SUPERSEDED',
                  ] as const
                ).map(st => (
                  <option key={st} value={st}>
                    {t.statuses[st] ?? st}
                  </option>
                ))}
              </select>
            </div>

            <div className="qx-field">
              <label htmlFor="atlas-version-scope">{r.versionScopeLabel}</label>
              <select
                id="atlas-version-scope"
                name="versionScope"
                defaultValue={activeFilterParams.versionScope ?? 'ALL'}
              >
                {(['ALL', 'LATEST', 'PREVIOUS'] as const).map(scope => (
                  <option key={scope} value={scope}>
                    {r.versionScopes[scope]}
                  </option>
                ))}
              </select>
            </div>

            <div className="qx-field">
              <label htmlFor="atlas-version-num">{r.versionNumberLabel}</label>
              <input
                id="atlas-version-num"
                name="version"
                type="number"
                min={1}
                max={1000}
                defaultValue={activeFilterParams.version ?? ''}
                placeholder={r.versionNumberPlaceholder}
              />
            </div>

            <div className="qx-field">
              <label htmlFor="atlas-from">{r.dateFromLabel}</label>
              <input
                id="atlas-from"
                name="from"
                type="date"
                defaultValue={activeFilterParams.from?.slice(0, 10) ?? ''}
              />
            </div>

            <div className="qx-field">
              <label htmlFor="atlas-to">{r.dateToLabel}</label>
              <input
                id="atlas-to"
                name="to"
                type="date"
                defaultValue={activeFilterParams.to?.slice(0, 10) ?? ''}
              />
            </div>
          </div>

          <div className="qx-button-row">
            <button type="submit">{r.applyFilters}</button>
            {hasUserFilter || activeFilterParams.cursor ? (
              <Link className="button secondary" href={`/${lang}/results`}>
                {r.resetFilters}
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      {page.failedOperations.length > 0 ? (
        <Card className="qx-failed-ops-card">
          <SectionHeading title={r.failedMissionsTitle} note={r.failedMissionsNote} />
          <ul className="qx-failed-ops-list">
            {page.failedOperations.map(failed => (
              <li key={failed.operationId} className="qx-failed-op-item">
                <div>
                  <Link
                    className="mission-title"
                    href={`/${lang}/missions/${encodeURIComponent(failed.operationId)}`}
                  >
                    {failed.title}
                  </Link>
                  <p className="muted">
                    {failed.documentCount === 0
                      ? r.failedNoDocuments
                      : `${failed.documentCount} ${r.failedPartialDocuments}`}{' '}
                    · {r.updatedLabel}: {stamp(lang, failed.lastActivityAt)}
                    {failed.lastErrorCode
                      ? ` · ${r.errorCodePrefix} ${failed.lastErrorCode}`
                      : ''}
                  </p>
                </div>
                <div className="qx-meta-row">
                  <StatusBadge status="FAILED" lang={lang} />
                  <Link
                    className="button secondary qx-small"
                    href={`/${lang}/missions/${encodeURIComponent(failed.operationId)}`}
                  >
                    {r.openMission}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {page.items.length === 0 ? (
        <Card>
          {page.workspaceDocumentCount === 0 && !hasUserFilter ? (
            <EmptyState title={r.emptyWorkspaceTitle} mark="◫">
              <span>{r.emptyWorkspaceBody}</span>
              <span className="qx-empty-actions">
                <Link className="button" href={`/${lang}/mydash`}>
                  {r.startMission}
                </Link>
                <Link className="button secondary" href={`/${lang}/services`}>
                  {r.browseServices}
                </Link>
              </span>
            </EmptyState>
          ) : (
            <EmptyState title={r.emptyFilteredTitle} mark="⌕">
              <span>{r.emptyFilteredBody}</span>
              <span className="qx-empty-actions">
                <Link className="button secondary" href={`/${lang}/results`}>
                  {r.resetFilters}
                </Link>
              </span>
            </EmptyState>
          )}
        </Card>
      ) : (
        <>
          <ul className="qx-atlas-card-list" aria-label={r.title}>
            {page.items.map(card => (
              <li key={card.id} className="qx-result-card">
                <div className="qx-result-card-top">
                  <div className="qx-result-card-titles">
                    <p className="qx-kicker">
                      {r.missionPrefix}{' '}
                      <Link href={`/${lang}/missions/${encodeURIComponent(card.operationId)}`}>
                        {card.operationTitle}
                      </Link>
                    </p>
                    <h2>
                      <Link href={`/${lang}/results/${encodeURIComponent(card.id)}`}>
                        {card.title}
                      </Link>
                    </h2>
                  </div>
                  <div className="qx-meta-row">
                    <StatusBadge status={card.status} lang={lang} />
                    <span
                      className={`badge ${card.isLatestVersion ? 'info' : 'neutral'}`}
                      data-latest={String(card.isLatestVersion)}
                    >
                      {r.versionPrefix}
                      {card.version} ·{' '}
                      {card.isLatestVersion
                        ? r.latestBadge
                        : `${r.supersededBadge}${card.latestVersionForOperation}`}
                    </span>
                    <span
                      className={`badge ${postureTone(card.verificationPosture)}`}
                      data-posture={card.verificationPosture}
                    >
                      {r.posture[card.verificationPosture]}
                    </span>
                  </div>
                </div>

                {card.operationStatus === 'FAILED' ? (
                  <div className="qx-result-alert qx-result-alert-danger" role="note">
                    <strong>{t.statuses.FAILED}:</strong> {r.failedOperationBanner}
                    {card.operationLastErrorCode
                      ? ` (${r.errorCodePrefix} ${card.operationLastErrorCode})`
                      : ''}
                  </div>
                ) : null}

                {card.verificationPosture === 'PARTIALLY_VERIFIED' ||
                card.verificationPosture === 'UNVERIFIED' ? (
                  <div className="qx-result-alert qx-result-alert-warn" role="note">
                    {r.postureNote[card.verificationPosture]}
                  </div>
                ) : null}

                <p className="qx-result-objective">{card.objective}</p>
                <p className="qx-result-verdict">{card.verdict}</p>

                <dl className="qx-result-facts">
                  <div>
                    <dt>{r.postureLabel}</dt>
                    <dd>
                      {card.counts.VERIFIED} {r.countsSummary.verified} · {card.counts.UNRESOLVED}{' '}
                      {r.countsSummary.unresolved} · {card.counts.AWAITING_ASSESSMENT}{' '}
                      {r.countsSummary.awaiting}
                    </dd>
                  </div>
                  <div>
                    <dt>{r.provenanceLabel}</dt>
                    <dd>
                      {card.provenance.citationCount === 0 ? (
                        <span className="muted">{r.noProvenanceRecorded}</span>
                      ) : (
                        <>
                          {card.provenance.verifiableCitationCount} {r.verifiableSources} /{' '}
                          {card.provenance.citationCount} {r.totalSources}
                          {card.provenance.providers.length > 0 ? (
                            <span className="muted">
                              {' '}
                              · {r.providersLabel} {card.provenance.providers.join(', ')}
                            </span>
                          ) : null}
                        </>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{r.updatedLabel}</dt>
                    <dd>
                      <time dateTime={card.lastUpdatedAt}>{stamp(lang, card.lastUpdatedAt)}</time>
                      <span className="muted">
                        {' '}
                        ({r.createdLabel}: {stamp(lang, card.createdAt)})
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>{r.storedExportsLabel}</dt>
                    <dd>
                      {card.availableExports.length > 0
                        ? card.availableExports.map(fmt => fmt.toUpperCase()).join(', ')
                        : r.noStoredExports}
                      {card.pendingExportCount > 0
                        ? ` · ${card.pendingExportCount} ${r.pendingExportsBadge}`
                        : ''}
                      {card.activeShareCount > 0
                        ? ` · ${card.activeShareCount} ${r.activeSharesBadge}`
                        : ''}
                    </dd>
                  </div>
                </dl>

                <div className="qx-result-card-actions">
                  <Link
                    className="button qx-small"
                    href={`/${lang}/results/${encodeURIComponent(card.id)}`}
                  >
                    {r.openResult}
                  </Link>
                  {card.previousVersionDocumentId ? (
                    <Link
                      className="button secondary qx-small"
                      href={`/${lang}/results/${encodeURIComponent(card.id)}?compareWith=${encodeURIComponent(card.previousVersionDocumentId)}#atlas-version-compare`}
                    >
                      {r.comparePrevious}
                    </Link>
                  ) : null}
                  {!card.isLatestVersion ? (
                    <Link
                      className="button secondary qx-small"
                      href={`/${lang}/results/${encodeURIComponent(card.latestDocumentId)}`}
                    >
                      {r.jumpLatest} (v{card.latestVersionForOperation}) →
                    </Link>
                  ) : null}
                  <Link
                    className="button secondary qx-small"
                    href={`/${lang}/missions/${encodeURIComponent(card.operationId)}`}
                  >
                    {r.openMission}
                  </Link>
                </div>
              </li>
            ))}
          </ul>

          <Card className="qx-pagination-bar">
            <p className="muted">
              {r.showingCount} <strong>{page.items.length}</strong> {r.ofTotal}{' '}
              <strong>{page.totalCount}</strong> {r.matchingVersions}
            </p>
            <div className="qx-button-row">
              {activeFilterParams.cursor ? (
                <Link
                  className="button secondary qx-small"
                  href={buildLibraryHref(lang, activeFilterParams, null)}
                >
                  {r.firstPage}
                </Link>
              ) : null}
              {page.nextCursor ? (
                <Link
                  className="button qx-small"
                  href={buildLibraryHref(lang, activeFilterParams, page.nextCursor)}
                >
                  {r.nextPage}
                </Link>
              ) : null}
            </div>
          </Card>
        </>
      )}
    </AppShell>
  );
}
