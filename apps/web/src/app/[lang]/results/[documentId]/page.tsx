import Link from 'next/link';
import { idSchema, type AtlasVerificationPosture } from '@qeynox/contracts';
import { AtlasResult, type AtlasDocument } from '../../../../components/atlas';
import {
  ResultExportPanel,
  ResultSharePanel,
} from '../../../../components/atlas-library-controls';
import {
  AppShell,
  Card,
  Feedback,
  PageHeader,
  SectionHeading,
  StatusBadge,
} from '../../../../components/ui';
import { session } from '../../../../lib/api';
import { copy, locale, type Locale } from '../../../../lib/copy';
import { readResultDetail, readResultShares } from '../../../../lib/results';
import { resultsCopy } from '../../../../lib/results-copy';

export const dynamic = 'force-dynamic';

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

function signedDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

function postureTone(posture: AtlasVerificationPosture): string {
  if (posture === 'VERIFIED_DELIVERABLE') return 'success';
  if (posture === 'AWAITING_REVIEW') return 'info';
  if (posture === 'PARTIALLY_VERIFIED') return 'warning';
  return 'neutral';
}

export default async function ResultLibraryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string; documentId: string }>;
  searchParams: Promise<{ compareWith?: string }>;
}) {
  const p = await params;
  const query = await searchParams;
  const lang = locale(p.lang);
  const t = copy[lang];
  const r = resultsCopy[lang];

  const configured = Boolean(process.env.QEYNOX_API_URL);
  const signedIn = Boolean(await session());

  const docId = idSchema.safeParse(p.documentId);
  const rawCompare =
    typeof query.compareWith === 'string' && query.compareWith.trim().length > 0
      ? query.compareWith.trim()
      : undefined;
  const compareParsed = rawCompare ? idSchema.safeParse(rawCompare) : null;

  if (!docId.success || (compareParsed && !compareParsed.success)) {
    return (
      <AppShell lang={lang} active="results" path={`results/${encodeURIComponent(p.documentId)}`}>
        <PageHeader eyebrow={r.eyebrow} title={r.title} />
        <Link href={`/${lang}/results`}>← {r.backToLibrary}</Link>
        <Feedback title={`${t.invalid} (INVALID_INPUT)`} error />
      </AppShell>
    );
  }

  if (!configured) {
    return (
      <AppShell lang={lang} active="results" path={`results/${docId.data}`}>
        <PageHeader eyebrow={r.eyebrow} title={r.title} />
        <Feedback title={t.notConfigured} />
      </AppShell>
    );
  }

  if (!signedIn) {
    return (
      <AppShell lang={lang} active="results" path={`results/${docId.data}`}>
        <PageHeader eyebrow={r.eyebrow} title={r.title} />
        <Feedback title={t.signInRequired}>
          <Link href={`/${lang}/account`}>{t.signin} →</Link>
        </Feedback>
      </AppShell>
    );
  }

  const outcome = await readResultDetail(docId.data, compareParsed?.data);
  if (!outcome.data) {
    const title =
      outcome.code === 'DENIED'
        ? t.denied
        : outcome.code === 'NOT_FOUND'
          ? `${t.missing} (NOT_FOUND)`
          : `${t.error} (${outcome.code})`;
    return (
      <AppShell lang={lang} active="results" path={`results/${docId.data}`}>
        <PageHeader eyebrow={r.eyebrow} title={r.title} />
        <Link href={`/${lang}/results`}>← {r.backToLibrary}</Link>
        <Card>
          <Feedback title={title} error />
        </Card>
      </AppShell>
    );
  }

  const detail = outcome.data;
  const doc = detail.document;

  const sharesOutcome =
    detail.canManageShares && doc.status === 'DELIVERABLE'
      ? await readResultShares(doc.id)
      : { data: [] as const };

  const atlasDoc: AtlasDocument = {
    id: doc.id,
    operationId: doc.operationId,
    version: doc.version,
    title: doc.title,
    objective: doc.objective,
    status: doc.status,
    scope: doc.scope,
    findings: doc.findings.map(f => ({
      claimId: f.claimId,
      statement: f.statement,
      status: f.status,
      limitations: f.limitations,
      citations: f.citations,
    })),
    nextActions: doc.nextActions,
    limitations: doc.limitations,
    unresolved: doc.unresolved,
    citations: doc.citations,
    createdAt: doc.createdAt,
    reviewedAt: doc.reviewedAt,
    reviewedBy: doc.reviewedBy,
    priorId: doc.priorId,
    interpretations: doc.interpretations,
    businessPack: doc.businessPack ? { pack: doc.businessPack.pack, contractKey: doc.businessPack.contractKey } : undefined,
  };

  const otherVersions = detail.versions.filter(v => v.id !== doc.id);
  const selectedCompareId =
    compareParsed?.data ??
    (detail.comparison
      ? detail.comparison.baseDocumentId === doc.id
        ? detail.comparison.targetDocumentId
        : detail.comparison.baseDocumentId
      : '');

  return (
    <AppShell lang={lang} active="results" path={`results/${doc.id}`}>
      <div className="qx-breadcrumb-bar">
        <Link href={`/${lang}/results`}>← {r.backToLibrary}</Link>
        <div className="qx-meta-row">
          <span className="muted">{r.missionPrefix}</span>
          <Link href={`/${lang}/missions/${encodeURIComponent(detail.operation.id)}`}>
            <strong>{detail.operation.title}</strong>
          </Link>
          <StatusBadge status={detail.operation.status} lang={lang} />
          <span className={`badge ${postureTone(detail.verificationPosture)}`}>
            {r.posture[detail.verificationPosture]}
          </span>
        </div>
      </div>

      {detail.operation.status === 'FAILED' ? (
        <Card className="qx-failed-ops-card">
          <p className="qx-error-code">
            <strong>{t.statuses.FAILED}:</strong> {r.failedOperationBanner}
            {detail.operation.lastErrorCode
              ? ` (${r.errorCodePrefix} ${detail.operation.lastErrorCode})`
              : ''}
          </p>
        </Card>
      ) : null}

      {detail.verificationPosture === 'PARTIALLY_VERIFIED' ||
      detail.verificationPosture === 'UNVERIFIED' ? (
        <Card>
          <div className="qx-result-alert qx-result-alert-warn" role="note">
            <strong>{r.posture[detail.verificationPosture]}:</strong>{' '}
            {r.postureNote[detail.verificationPosture]}
          </div>
        </Card>
      ) : null}

      <Card id="atlas-versions">
        <SectionHeading
          title={r.versionHistoryTitle}
          note={r.versionHistoryNote}
          action={
            <div className="qx-button-row">
              {detail.previousVersionDocumentId ? (
                <Link
                  className="button secondary qx-small"
                  href={`/${lang}/results/${encodeURIComponent(detail.previousVersionDocumentId)}`}
                >
                  {r.previousVersionBtn}
                </Link>
              ) : null}
              {detail.nextVersionDocumentId ? (
                <Link
                  className="button secondary qx-small"
                  href={`/${lang}/results/${encodeURIComponent(detail.nextVersionDocumentId)}`}
                >
                  {r.nextVersionBtn}
                </Link>
              ) : null}
              {!detail.isLatestVersion ? (
                <Link
                  className="button qx-small"
                  href={`/${lang}/results/${encodeURIComponent(detail.latestDocumentId)}`}
                >
                  {r.jumpToLatestBtn}
                </Link>
              ) : null}
            </div>
          }
        />

        <ul className="qx-version-list">
          {detail.versions.map(v => {
            const isCurrent = v.id === doc.id;
            return (
              <li
                key={v.id}
                className={`qx-version-item ${isCurrent ? 'is-current' : ''}`}
                aria-current={isCurrent ? 'true' : undefined}
              >
                <div className="qx-meta-row">
                  <strong>v{v.version}</strong>
                  <StatusBadge status={v.status} lang={lang} />
                  {v.isLatestVersion ? <span className="badge info">{r.latestBadge}</span> : null}
                  {isCurrent ? (
                    <span className="badge neutral">{r.currentViewingBadge}</span>
                  ) : null}
                </div>
                <p className="muted">
                  {stamp(lang, v.createdAt)} · {v.counts.VERIFIED} {r.countsSummary.verified} ·{' '}
                  {v.counts.UNRESOLVED} {r.countsSummary.unresolved} · {v.citationCount}{' '}
                  {r.totalSources}
                </p>
                {!isCurrent ? (
                  <div className="qx-button-row">
                    <Link
                      className="button secondary qx-small"
                      href={`/${lang}/results/${encodeURIComponent(v.id)}`}
                    >
                      {r.openResult} (v{v.version})
                    </Link>
                    <Link
                      className="button secondary qx-small"
                      href={`/${lang}/results/${encodeURIComponent(doc.id)}?compareWith=${encodeURIComponent(v.id)}#atlas-version-compare`}
                    >
                      {r.compareApply} v{v.version}
                    </Link>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card id="atlas-version-compare">
        <SectionHeading title={r.compareTitle} note={r.compareSubtitle} />
        {otherVersions.length === 0 ? (
          <p className="muted">{r.noPriorVersion}</p>
        ) : (
          <>
            <form
              method="GET"
              action={`/${lang}/results/${encodeURIComponent(doc.id)}`}
              className="qx-compare-selector"
            >
              <label htmlFor="compare-select">{r.compareWithLabel}</label>
              <div className="qx-compare-selector-row">
                <select
                  id="compare-select"
                  name="compareWith"
                  defaultValue={selectedCompareId}
                >
                  {otherVersions.map(v => (
                    <option key={v.id} value={v.id}>
                      v{v.version} · {t.statuses[v.status] ?? v.status} ({stamp(lang, v.createdAt)})
                    </option>
                  ))}
                </select>
                <button type="submit" className="secondary">
                  {r.compareApply}
                </button>
              </div>
            </form>

            {detail.comparison ? (
              <div className="qx-comparison-body">
                <div className="qx-comparison-summary">
                  <div>
                    <span className="qx-kicker">
                      v{detail.comparison.baseVersion} → v{detail.comparison.targetVersion}
                    </span>
                    <p>
                      <strong>{r.statusTransitionLabel}:</strong>{' '}
                      {t.statuses[detail.comparison.baseStatus] ?? detail.comparison.baseStatus} →{' '}
                      {t.statuses[detail.comparison.targetStatus] ?? detail.comparison.targetStatus}{' '}
                      {!detail.comparison.statusChanged ? `(${r.unchanged})` : ''}
                    </p>
                  </div>
                  <dl className="qx-delta-grid">
                    <div>
                      <dt>{r.deltaVerified}</dt>
                      <dd>{signedDelta(detail.comparison.verifiedDelta)}</dd>
                    </div>
                    <div>
                      <dt>{r.deltaUnresolved}</dt>
                      <dd>{signedDelta(detail.comparison.unresolvedDelta)}</dd>
                    </div>
                    <div>
                      <dt>{r.deltaAwaiting}</dt>
                      <dd>{signedDelta(detail.comparison.awaitingDelta)}</dd>
                    </div>
                    <div>
                      <dt>{r.deltaCitations}</dt>
                      <dd>{signedDelta(detail.comparison.citationDelta)}</dd>
                    </div>
                  </dl>
                </div>

                {detail.comparison.changedFindings.length === 0 &&
                detail.comparison.addedFindings.length === 0 &&
                detail.comparison.removedFindings.length === 0 ? (
                  <p className="muted">{r.noFindingDiff}</p>
                ) : (
                  <div className="qx-diff-sections">
                    {detail.comparison.changedFindings.length > 0 ? (
                      <div>
                        <h3>{r.changedFindingsTitle}</h3>
                        <ul className="qx-diff-list">
                          {detail.comparison.changedFindings.map(item => (
                            <li key={item.claimId}>
                              <strong>{item.statement}</strong>
                              <span className="muted">
                                {item.fromStatus} ({item.fromClass}) → {item.toStatus} (
                                {item.toClass})
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {detail.comparison.addedFindings.length > 0 ? (
                      <div>
                        <h3>{r.addedFindingsTitle}</h3>
                        <ul className="qx-diff-list">
                          {detail.comparison.addedFindings.map(item => (
                            <li key={item.claimId}>
                              <strong>+ {item.statement}</strong>
                              <span className="muted">
                                {item.status} ({item.findingClass})
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {detail.comparison.removedFindings.length > 0 ? (
                      <div>
                        <h3>{r.removedFindingsTitle}</h3>
                        <ul className="qx-diff-list">
                          {detail.comparison.removedFindings.map(item => (
                            <li key={item.claimId}>
                              <strong>− {item.statement}</strong>
                              <span className="muted">
                                {item.status} ({item.findingClass})
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}
          </>
        )}
      </Card>

      <AtlasResult
        doc={atlasDoc}
        lang={lang}
        exportsSlot={
          <section aria-labelledby="atlas-exports-heading">
            <h2 id="atlas-exports-heading">{r.exportsTitle}</h2>
            <p className="muted">{r.exportsSubtitle}</p>
            <ResultExportPanel
              lang={lang}
              operationId={doc.operationId}
              documentId={doc.id}
              artifacts={detail.artifacts}
              canExportNew={detail.canExportNew}
              artifactStoreConfigured={detail.artifactStoreConfigured}
            />
          </section>
        }
      />

      <Card id="atlas-sharing">
        <SectionHeading title={r.shareTitle} note={r.shareSubtitle} />
        <ResultSharePanel
          lang={lang}
          documentId={doc.id}
          isDeliverable={doc.status === 'DELIVERABLE'}
          canManageShares={detail.canManageShares}
          shares={sharesOutcome.data ?? []}
        />
      </Card>
    </AppShell>
  );
}
