import Link from 'next/link';
import { z } from 'zod';
import { AppShell, Card, EmptyState, Feedback, PageHeader, SectionHeading, StatusBadge } from './ui';
import { MissionForm } from './forms';
import { api, ApiError, recentSchema, session } from '../lib/api';
import { copy, type Locale } from '../lib/copy';
import { missionCopy } from '../lib/mission-copy';
import { capabilityCatalogueSchema, readinessSchema, type CapabilityCatalogue } from '../lib/plan';

const guidanceSchema = z.object({ operationId: z.string(), action: z.string(), reason: z.string() });
const onboardingSchema = z.object({ status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'DISMISSED']) });
type Row = z.infer<typeof recentSchema>[number];
const finished = ['COMPLETED', 'SUPERSEDED'];

function stamp(lang: Locale, value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC';
}

function dict(value: Record<string, string>, key: string, fallback: string) {
  return value[key] ?? fallback;
}

export async function Workspace({ lang, listOnly = false }: { lang: Locale; listOnly?: boolean }) {
  const t = copy[lang];
  const m = missionCopy(lang);
  const signedIn = Boolean(await session());
  const configured = Boolean(process.env.QEYNOX_API_URL);
  let rows: Row[] = [];
  let failure = '';
  if (signedIn && configured) {
    try { rows = recentSchema.parse(await api('/v1/mydash/recent?limit=30')); }
    catch (error) { failure = error instanceof ApiError ? error.code : 'UNAVAILABLE'; }
  }

  let soulStatus: string | null = null;
  if (signedIn && configured) {
    try { soulStatus = onboardingSchema.parse(await api('/v1/soul/onboarding')).status; }
    catch { soulStatus = null; }
  }

  const active = rows.filter(row => !finished.includes(row.status));
  const decisions = rows.filter(row => row.pendingApprovals > 0 || ['APPROVAL', 'REQUIRES_REVIEW', 'FAILED'].includes(row.attention));
  const withResults = rows.filter(row => row.resultCount > 0);
  const resultTotal = withResults.reduce((total, row) => total + row.resultCount, 0);
  const focus = active.slice(0, 3);
  let guidance: { operationId: string; action: string }[] = [];
  if (focus.length && configured) {
    const fetched = await Promise.all(focus.map(async row => {
      try {
        const value = guidanceSchema.parse(await api('/v1/pilot/operations/' + encodeURIComponent(row.operationId) + '/next-action'));
        return { operationId: row.operationId, action: value.action };
      } catch { return null; }
    }));
    guidance = fetched.filter((item): item is { operationId: string; action: string } => item !== null);
  }
  const actionFor = new Map(guidance.map(item => [item.operationId, item.action]));

  const readinessFor = new Map<string, { canStart: boolean; code: string }>();
  if (focus.length && configured) {
    const fetched = await Promise.all(focus.map(async row => {
      try {
        const value = readinessSchema.parse(await api('/v1/operations/' + encodeURIComponent(row.operationId) + '/readiness'));
        return { operationId: row.operationId, canStart: value.canStart, code: value.blockers[0]?.code ?? '' };
      } catch { return null; }
    }));
    for (const item of fetched) if (item) readinessFor.set(item.operationId, { canStart: item.canStart, code: item.code });
  }
  const blockerLabel = (code: string) => (m.flow.blocker as Record<string, string>)[code] ?? code;

  let catalogue: CapabilityCatalogue | null = null;
  if (signedIn && configured) {
    try { catalogue = capabilityCatalogueSchema.parse(await api('/v1/capabilities')); }
    catch { catalogue = null; }
  }

  const soulLabel = soulStatus ? dict(t.soulStatus as Record<string, string>, soulStatus, soulStatus) : '';

  const signInNotice = !configured
    ? <Feedback title={t.notConfigured} />
    : !signedIn
      ? <Feedback title={t.signInRequired}><Link href={'/' + lang + '/account'}>{t.signin} →</Link></Feedback>
      : null;

  if (listOnly) {
    return (
      <AppShell lang={lang} active="missions">
        <PageHeader
          eyebrow={t.eyebrow}
          title={t.missions}
          description={t.recentNote}
          aside={<Link className="button secondary" href={'/' + lang + '/missions'}>{t.refresh}</Link>}
        />
        {signInNotice}
        {!signedIn || !configured ? null : failure ? (
          <Card><Feedback title={failure === 'DENIED' ? t.denied : failure === 'NOT_CONFIGURED' ? t.notConfigured : t.error} error /></Card>
        ) : rows.length === 0 ? (
          <Card><EmptyState title={t.empty}>{t.emptyCopy}</EmptyState></Card>
        ) : (
          <Card>
            <table className="qx-table">
              <caption className="qx-sr-only">{t.recent}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.missions}</th>
                  <th scope="col">{t.status}</th>
                  <th scope="col">{t.stepsLabel}</th>
                  <th scope="col">{t.resultsCount}</th>
                  <th scope="col">{t.updated}</th>
                  <th scope="col"><span className="qx-sr-only">{t.view}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.operationId}>
                    <td data-label={t.missions}><Link className="mission-title" href={'/' + lang + '/missions/' + encodeURIComponent(row.operationId)}>{row.title}</Link></td>
                    <td data-label={t.status}><StatusBadge status={row.status} lang={lang} /></td>
                    <td data-label={t.stepsLabel}>{row.completedSteps + ' / ' + row.stepCount}</td>
                    <td data-label={t.resultsCount}>{row.resultCount}</td>
                    <td data-label={t.updated}>{stamp(lang, row.lastActivityAt)}</td>
                    <td className="qx-table-action"><Link className="button secondary qx-small" href={'/' + lang + '/missions/' + encodeURIComponent(row.operationId)}>{t.openMission}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </AppShell>
    );
  }

  return (
    <AppShell lang={lang} active="mydash">
      <section className="hero qx-hero">
        <span className="orbit" aria-hidden="true" />
        <p className="eyebrow">{t.eyebrow}</p>
        <h1>{t.dashTitle}</h1>
        <p className="qx-hero-lead">{t.dashIntro}</p>
      </section>

      <div className="qx-focus-card">
        <MissionForm lang={lang} enabled={signedIn && configured} />
        {signInNotice}
      </div>

      {signedIn && configured && !failure ? (
        <>
          <div className="qx-metrics" role="list">
            <div className="qx-metric" role="listitem"><span className="qx-metric-value">{active.length}</span><span className="qx-metric-label">{t.statsActive}</span></div>
            <div className="qx-metric" role="listitem"><span className="qx-metric-value">{decisions.length}</span><span className="qx-metric-label">{t.statsDecisions}</span></div>
            <div className="qx-metric" role="listitem"><span className="qx-metric-value">{resultTotal}</span><span className="qx-metric-label">{t.statsResults}</span></div>
          </div>

          <div className="qx-columns">
            <Card>
              <SectionHeading title={t.inProgress} note={t.inProgressNote} action={<Link className="button secondary qx-small" href={'/' + lang + '/missions'}>{t.missions}</Link>} />
              {active.length === 0 ? <EmptyState title={t.noInProgress}>{t.emptyCopy}</EmptyState> : (
                <ul className="mission-list">
                  {active.map(row => {
                    const state = readinessFor.get(row.operationId);
                    return (
                      <li key={row.operationId}>
                        <div>
                          <Link className="mission-title" href={'/' + lang + '/missions/' + encodeURIComponent(row.operationId)}>{row.title}</Link>
                          <p className="muted">{row.completedSteps + ' / ' + row.stepCount + ' · ' + t.stepsLabel + ' · ' + t.updated + ' ' + stamp(lang, row.lastActivityAt)}</p>
                          {state ? (
                            state.canStart
                              ? <p className="qx-ready-line">{t.readyToLaunch}</p>
                              : state.code ? <p className="qx-blocked-line">{t.blockedBy}{blockerLabel(state.code)}</p> : null
                          ) : null}
                        </div>
                        <StatusBadge status={row.status} lang={lang} />
                        <Link href={'/' + lang + '/missions/' + encodeURIComponent(row.operationId)}>{t.openMission} →</Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <div className="qx-stack">
              <Card>
                <SectionHeading title={t.decisions} note={t.decisionsNote} />
                {decisions.length === 0 ? <p className="muted qx-empty-line">{t.noDecisions}</p> : (
                  <ul className="qx-decision-list">
                    {decisions.map(row => (
                      <li key={row.operationId}>
                        <Link className="mission-title" href={'/' + lang + '/missions/' + encodeURIComponent(row.operationId)}>{row.title}</Link>
                        <span className="qx-decision-meta">{dict(t.attention as Record<string, string>, row.attention, row.attention)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card>
                <SectionHeading title={t.capabilities} />
                {catalogue ? (
                  <>
                    <p className="qx-capacity"><strong>{catalogue.available}</strong> / {catalogue.total} <span className="muted">{t.capabilityPage.slotsLabel} · {t.capabilityPage.availableCount}</span></p>
                    <p className="muted">{catalogue.active} {t.capabilityPage.activeCount}</p>
                  </>
                ) : <p className="muted">{t.unavailable}</p>}
                <Link className="button secondary qx-small" href={'/' + lang + '/capabilities'}>{t.capabilities} →</Link>
              </Card>

              <Card>
                <SectionHeading title={t.soulSpace} note={t.soulSpaceCopy} />
                {soulStatus ? (
                  <p className="qx-soul-state">{t.soulStatusLabel}: <strong>{soulLabel}</strong></p>
                ) : <p className="muted">{t.unavailable}</p>}
                <Link className="button secondary qx-small" href={'/' + lang + '/soul'}>{t.openSoul} →</Link>
              </Card>

              <Card>
                <SectionHeading title={t.pilotSpace} note={t.pilotSpaceCopy} />
                {guidance.length ? (
                  <ul className="qx-decision-list">
                    {focus.filter(row => actionFor.has(row.operationId)).map(row => (
                      <li key={row.operationId}>
                        <Link className="mission-title" href={'/' + lang + '/missions/' + encodeURIComponent(row.operationId)}>{row.title}</Link>
                        <span className="qx-pilot-action">{dict(t.pilotActions as Record<string, string>, actionFor.get(row.operationId) ?? '', '')}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="muted">{focus.length ? t.pilotUnavailable : t.pilotNoAction}</p>}
              </Card>
            </div>
          </div>

          <Card>
            <SectionHeading title={t.latestResults} note={t.latestResultsNote} />
            {withResults.length === 0 ? <EmptyState title={t.noResults} mark="◫" /> : (
              <ul className="mission-list">
                {withResults.slice(0, 8).map(row => (
                  <li key={row.operationId}>
                    <div>
                      <Link className="mission-title" href={'/' + lang + '/missions/' + encodeURIComponent(row.operationId)}>{row.title}</Link>
                      <p className="muted">{row.resultCount + ' ' + t.resultsCount.toLowerCase()} · {t.updated} {stamp(lang, row.lastActivityAt)}</p>
                    </div>
                    <StatusBadge status={row.status} lang={lang} />
                    <Link href={'/' + lang + '/missions/' + encodeURIComponent(row.operationId)}>{t.openMission} →</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : failure ? (
        <Card>
          <Feedback error title={failure === 'DENIED' ? t.denied : failure === 'NOT_CONFIGURED' ? t.notConfigured : t.error}>
            {failure}
          </Feedback>
        </Card>
      ) : null}
    </AppShell>
  );
}
