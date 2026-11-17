import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { AppShell, Card, EmptyState, Feedback, SectionHeading, StatusBadge } from '../../../../components/ui';
import { ChangeForm, RefreshMission } from '../../../../components/mission-controls';
import { AcceptQuoteForm, ApprovalDecision, ClaimReviewForm, QuoteForm, ReassembleForm, StartMission } from '../../../../components/mission-flow';
import { FlowHeader, FlowWorkspace } from '../../../../components/flow';
import { PlanEditor, type DraftStep } from '../../../../components/plan-editor';
import { copy, locale } from '../../../../lib/copy';
import { flowCopy } from '../../../../lib/flow-copy';
import { buildFlowModel, stateOf } from '../../../../lib/flow-model';
import { missionCopy } from '../../../../lib/mission-copy';
import { read, detailSchema, summarySchema, activitySchema, documentSchema, guidanceSchema, contextSchema } from '../../../../lib/mission';
import { planViewSchema, readinessSchema, commercialViewSchema, claimListSchema, formatMoney, type PlanAttempt } from '../../../../lib/plan';

const consentsSchema = z.array(z.object({ id: z.string(), scope: z.array(z.string()).optional(), scopes: z.array(z.string()).optional(), revokedAt: z.string().optional(), expiresAt: z.string().optional(), grantedAt: z.string() }));

const stamp = (lang: 'en' | 'fr', value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC'
    : value;
};
const dict = (value: Record<string, string>, key: string, fallback: string) => value[key] ?? fallback;

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string; id: string }>; searchParams: Promise<{ after?: string }> }) {
  const p = await params;
  const lang = locale(p.lang);
  const t = copy[lang];
  const m = missionCopy(lang);
  const f = m.flow;
  const flowHeader = flowCopy(lang).header;
  const id = idSchema.safeParse(p.id);
  if (!id.success) return <AppShell lang={lang} active="missions"><Feedback title={t.missing} error /></AppShell>;

  const base = '/v1/operations/' + id.data;
  const operation = await read(base, detailSchema);
  if (!operation.data) {
    return <AppShell lang={lang} active="missions"><Link href={'/' + lang + '/mydash'}>← {t.back}</Link><Feedback title={t.missing + ' (' + operation.code + ')'} error /></AppShell>;
  }
  const op = operation.data;
  const pageSize = 50;
  const requestedAfter=(await searchParams).after;
  const summary=await read('/v1/mydash/operations/' + id.data + '/summary', summarySchema);
  const after = z.coerce.number().int().nonnegative().safeParse(requestedAfter ?? 0);
  const cursor = requestedAfter===undefined&&summary.data?.operationId===id.data ? Math.max(0,summary.data.lastSequence-pageSize) : after.success ? after.data : 0;
  const [plan, readiness, activity, pilot, commercial, claims, documents, facts, consents] = await Promise.all([
    read(base + '/plan', planViewSchema),
    read(base + '/readiness', readinessSchema),
    read('/v1/mydash/operations/' + id.data + '/activity?after=' + cursor + '&limit=' + pageSize, activitySchema),
    read('/v1/pilot/operations/' + id.data + '/next-action', guidanceSchema),
    read(base + '/commercial', commercialViewSchema),
    read(base + '/claims', claimListSchema),
    read(base + '/documents', z.array(documentSchema)),
    read('/v1/soul/context', contextSchema),
    read('/v1/soul/consents', consentsSchema),
  ]);

  const planData = plan.data && plan.data.operation.id === op.id ? plan.data : null;
  const planStale = planData !== null && planData.operation.version !== op.version;
  const planState = stateOf(plan, planData, { stale: planStale });
  const readinessData = readiness.data && readiness.data.operationId === op.id ? readiness.data : null;
  const readinessStale = readinessData !== null && readinessData.version !== op.version;
  const readinessState = stateOf(readiness, readinessData, { stale: readinessStale });
  const readinessCanStart = Boolean(readinessData?.canStart) && !readinessStale;
  const summaryData = summary.data && summary.data.operationId === op.id ? summary.data : null;
  const summaryState = stateOf(summary, summaryData);
  const activityData = activity.data ?? null;
  const activityState = stateOf(activity, activityData, { empty: Boolean(activityData && activityData.events.length === 0) });
  const pilotData = pilot.data && pilot.data.operationId === op.id ? pilot.data : null;
  const pilotState = stateOf(pilot, pilotData);
  const commercialData = commercial.data && commercial.data.operationId === op.id ? commercial.data : null;
  const commercialState = stateOf(commercial, commercialData);
  const claimsData = claims.data ?? null;
  const claimsState = stateOf(claims, claimsData, { empty: Boolean(claimsData && claimsData.length === 0) });
  const documentsData = documents.data ?? null;
  const resultDocuments = (documentsData ?? []).filter(doc => doc.operationId === op.id);
  const documentsState = stateOf(documents, documentsData, { empty: Boolean(documentsData && resultDocuments.length === 0) });
  const factsData = facts.data ?? null;
  const factsState = stateOf(facts, factsData, { empty: Boolean(factsData && factsData.length === 0) });
  const grantedConsent = (consents.data ?? []).some(consent => !consent.revokedAt && (!consent.expiresAt || Date.parse(consent.expiresAt) > Date.now()));

  const steps = planData?.steps ?? [];
  const stepCount = summaryData?.stepCount ?? steps.length;
  const completedSteps = summaryData?.completedSteps ?? steps.filter(step => step.state === 'COMPLETED').length;
  const progress = stepCount > 0 ? Math.round((completedSteps / stepCount) * 100) : 0;
  const capabilities = planData?.capabilities ?? [];
  const capabilityName = (capabilityId: string) => capabilities.find(item => item.id === capabilityId)?.name ?? capabilityId;
  const attemptsFor = new Map<string, PlanAttempt[]>();
  for (const attempt of planData?.attempts ?? []) {
    const list = attemptsFor.get(attempt.stepId);
    if (list) list.push(attempt);
    else attemptsFor.set(attempt.stepId, [attempt]);
  }
  for (const list of attemptsFor.values()) list.sort((left, right) => right.sequence - left.sequence);
  const pendingApprovals = planData && !planStale
    ? (planData.approvals ?? []).filter(approval => approval.status === 'PENDING' && !approval.stale)
    : [];
  const commercialRevision = commercialData?.revisionId ?? null;
  const editable = !planStale && ['DRAFT', 'READY', 'INTERRUPTED', 'FAILED', 'COMPLETED'].includes(op.status);
  const running = ['RUNNING', 'WAITING_APPROVAL', 'INTERRUPT_REQUESTED'].includes(op.status);
  const canInterrupt = ['RUNNING', 'WAITING_APPROVAL'].includes(op.status);
  const redoAllowed = !planStale && ['READY', 'INTERRUPTED', 'FAILED', 'COMPLETED'].includes(op.status);
  const initialSteps: DraftStep[] = steps.map((step, position) => ({
    key: 's' + position,
    title: step.title,
    description: step.description,
    capabilityId: step.capabilityId,
    intent: step.intent,
    dependsOn: step.dependsOn.map(dependency => {
      const source = steps.findIndex(candidate => candidate.id === dependency);
      return source >= 0 ? 's' + source : '';
    }).filter(key => key.length > 0),
  }));
  const unavailable = (code?: string) => <Feedback title={m.unavailable + ' (' + (code ?? 'INVALID_RESPONSE') + ')'} error />;

  const model = buildFlowModel({
    lang,
    cursor,
    pageSize,
    operation: {
      id: op.id,
      title: op.title,
      status: op.status,
      version: op.version,
      lastActivityAt: op.lastActivityAt,
      lastErrorCode: planData?.operation.lastErrorCode ?? null,
    },
    plan: planData,
    planState,
    readiness: readinessData,
    readinessState,
    summary: summaryData,
    summaryState,
    activity: activityData,
    activityState,
    pilot: pilotData,
    pilotState,
    commercial: commercialData,
    commercialState,
    claims: claimsData,
    claimsState,
    documents: documentsData,
    documentsState,
    facts: factsData,
    factsState,
    consent: consents.data
      ? { state: grantedConsent ? 'granted' : 'not_granted' }
      : { state: 'unavailable', code: consents.code },
  });

  const approvalsCard = pendingApprovals.length > 0 ? (
    <Card id="flow-approvals" className="qx-approvals">
      <SectionHeading title={f.approvalsTitle} />
      {pendingApprovals.map(approval => (
        <div key={approval.id} className="qx-approval">
          <p><span className="qx-kicker">{f.approvalPurpose}</span> {approval.purpose}</p>
          <p className="muted">{f.approvalExpires}: {stamp(lang, approval.expiresAt)}</p>
          <ApprovalDecision lang={lang} operationId={op.id} approvalId={approval.id} />
        </div>
      ))}
    </Card>
  ) : null;

  const readinessCard = (
    <Card id="flow-launch" className="qx-launch-card">
      <SectionHeading title={f.readinessTitle} />
      {readinessData ? (
        <>
          <p className={readinessCanStart ? 'qx-ready' : 'qx-not-ready'}>
            <span aria-hidden="true">{readinessCanStart ? '✓' : '!'}</span>{' '}
            {readinessCanStart ? f.readinessReady : f.readinessBlocked}
          </p>
          {readinessData.blockers.length > 0 ? (
            <ul className="qx-blockers">
              {readinessData.blockers.map(blocker => (
                <li key={blocker.code + blocker.detail}>
                  <span className="qx-kicker">{dict(f.category as Record<string, string>, blocker.category, blocker.category)}</span>
                  <strong>{dict(f.blocker as Record<string, string>, blocker.code, blocker.code)}</strong>
                  <span className="muted">{blocker.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {readinessData.plan.present ? <ul className="qx-prereqs" aria-label={f.prerequisitesTitle}>
            {prerequisiteChecks(readinessData).map(item => (
              <li key={item.label} data-ok={item.ok ? 'true' : 'false'}>
                <span className="qx-prereq-state" aria-hidden="true">{item.ok ? '✓' : '!'}</span>
                <span className="qx-prereq-label">{item.label}</span>
                <span className="qx-sr-only">{item.ok ? f.checkOk : f.checkKo}</span>
                {!item.ok && item.missing.length ? <small>{item.missing.join(', ')}</small> : null}
              </li>
            ))}
          </ul> : null}
          <dl className="qx-readiness-grid">
            <div><dt>{f.planState}</dt><dd>{readinessData.plan.present ? f.planRecorded + (readinessData.plan.revision ? ' · v' + readinessData.plan.revision : '') : f.planMissing}</dd></div>
            <div><dt>{f.capabilitiesState}</dt><dd>{readinessData.capabilities.active + ' / ' + readinessData.capabilities.required}</dd></div>
            <div><dt>{f.costTitle}</dt><dd>{readinessData.cost.known ? formatMoney(readinessData.cost.amountMinor, readinessData.cost.currency, lang) : '—'}</dd></div>
            <div><dt>{f.budgetTitle}</dt><dd>{readinessData.budget.configured ? formatMoney(readinessData.budget.maxMoneyMinor, readinessData.budget.currency, lang) : '—'}</dd></div>
          </dl>
          <div className="qx-readiness-detail">
            <p><span className="qx-kicker">{f.costTitle}</span>{' '}{readinessData.cost.known ? formatMoney(readinessData.cost.amountMinor, readinessData.cost.currency, lang) : f.costUnknown}{readinessData.cost.orderState ? <> <StatusBadge status={readinessData.cost.orderState} lang={lang} /></> : null}</p>
            <p><span className="qx-kicker">{f.authorizationsTitle}</span>{' '}{readinessData.cost.known ? f.scopeAccepted : f.scopeNotAccepted}</p>
            {readinessData.budget.configured ? <p className="muted">{f.budgetSpent}: {formatMoney(readinessData.budget.spentMinor, readinessData.budget.currency, lang)} · {f.budgetReserved}: {formatMoney(readinessData.budget.reservedMinor, readinessData.budget.currency, lang)}</p> : <p className="muted">{f.budgetUnknown}</p>}
          </div>
          {readinessStale ? (
            <Feedback error title={flowHeader.staleTitle}>{flowHeader.staleBody}</Feedback>
          ) : op.status === 'INTERRUPTED' || op.status === 'FAILED' ? (
            <>
              <p className="muted qx-hint">{f.resumeNote}</p>
              <StartMission lang={lang} operationId={op.id} version={op.version} canStart={readinessCanStart} idempotencyKey={crypto.randomUUID()} label={f.resume} />
            </>
          ) : (
            <StartMission lang={lang} operationId={op.id} version={op.version} canStart={readinessCanStart} idempotencyKey={crypto.randomUUID()} />
          )}
        </>
      ) : unavailable(readiness.code)}
    </Card>
  );

  const planCard = (
    <Card id="flow-plan">
      <SectionHeading title={f.planTitle} note={planData?.revision ? f.revisionReason + ': ' + planData.revision.reason : f.planNoneCopy} />
      {planStale ? <p className="qx-not-ready">{flowHeader.staleBody}</p> : null}
      {!planData ? unavailable(plan.code) : steps.length === 0 ? (
        <>
          <h3>{f.planNone}</h3>
          <PlanEditor lang={lang} operationId={op.id} version={op.version} mode="create" capabilities={capabilities} initialSteps={[]} />
        </>
      ) : (
        <>
          <p className="muted">{f.revision} {planData.revision?.revision ?? 1} · {stamp(lang, planData.revision?.createdAt ?? op.lastActivityAt)}</p>
          <ol className="qx-steps">
            {steps.map((step, position) => {
              const history = attemptsFor.get(step.id) ?? [];
              const attempt = history[0];
              return (
                <li key={step.id} className="qx-step-view">
                  <div className="qx-step-top">
                    <span className="qx-step-index" aria-hidden="true">{position + 1}</span>
                    <div className="qx-step-copy">
                      <h3>{step.title}</h3>
                      <p className="muted">{step.description}</p>
                    </div>
                    <StatusBadge status={step.state} lang={lang} />
                  </div>
                  <dl className="qx-step-meta">
                    <div><dt>{f.stepCapability}</dt><dd>{capabilityName(step.capabilityId)}</dd></div>
                    <div><dt>{f.stepIntent}</dt><dd>{dict(f.intent as Record<string, string>, step.intent, step.intent)}</dd></div>
                    <div><dt>{f.stepDepends}</dt><dd>{step.dependsOn.length ? step.dependsOn.map(dependency => capabilityName(steps.find(candidate => candidate.id === dependency)?.capabilityId ?? dependency)).join(', ') : '—'}</dd></div>
                  </dl>
                  {attempt ? (
                    <p className="muted">
                      {f.attemptSequence} {attempt.sequence} · {dict(f.stepStates as Record<string, string>, attempt.state, attempt.state)}
                      {attempt.startedAt ? ' · ' + f.startedAt + ' ' + stamp(lang, attempt.startedAt) : ''}
                      {attempt.errorCode ? ' · ' + attempt.errorCode : ''}
                    </p>
                  ) : null}
                  {history.length > 1 ? (
                    <details className="qx-attempts">
                      <summary>{f.attemptsHistory} ({history.length})</summary>
                      <ol>
                        {history.map(item => (
                          <li key={item.attemptId}>
                            <strong>#{item.sequence}</strong> · {dict(f.stepStates as Record<string, string>, item.state, item.state)}
                            {item.startedAt ? ' · ' + f.startedAt + ' ' + stamp(lang, item.startedAt) : ''}
                            {item.finishedAt ? ' · ' + stamp(lang, item.finishedAt) : ''}
                            {item.errorCode ? ' · ' + f.attemptError + ': ' + item.errorCode : ''}
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                  {redoAllowed && attempt && attempt.state !== 'RUNNING' && attempt.state !== 'WAITING_APPROVAL' ? (
                    <ChangeForm lang={lang} label={f.redo} fields={{ kind: 'redo', operationId: op.id, attemptId: attempt.attemptId, version: String(op.version), idempotencyKey: crypto.randomUUID() }}>
                      <p className="muted qx-hint">{f.redoNote}</p>
                      <label className="qx-check"><input type="checkbox" name="confirm" required /> <span>{f.redoConfirm}</span></label>
                    </ChangeForm>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {editable ? (
            <details className="qx-plan-edit">
              <summary>{f.editPlan}</summary>
              <PlanEditor lang={lang} operationId={op.id} version={op.version} mode={planData.revision ? 'revise' : 'create'} revisionId={planData.revision?.id} capabilities={capabilities} initialSteps={initialSteps} />
            </details>
          ) : null}
        </>
      )}
    </Card>
  );

  const commercialCard = (
    <Card id="flow-commercial">
      <SectionHeading title={f.commercialTitle} note={f.commercialIntro} />
      {!commercialData ? unavailable(commercial.code) : commercialRevision === null ? <p className="muted">{f.quoteNeedsPlan}</p> : (
        <>
          {commercialData.offers.length === 0 ? <p className="muted">{f.noCommercialOffer}</p> : (
            <ul className="qx-offer-list">
              {commercialData.offers.map(offer => (
                <li key={offer.id}>
                  <div>
                    <strong>{offer.label}</strong>
                    <p className="muted">{formatMoney(offer.amountMinor, offer.currency, lang)} · {offer.termsVersion}{offer.isExplicitlyFree ? ' · ' + f.freeOffer : ''}</p>
                  </div>
                  <QuoteForm lang={lang} operationId={op.id} revisionId={commercialRevision} offerId={offer.id} />
                </li>
              ))}
            </ul>
          )}
          {commercialData.quotes.length === 0 ? <p className="muted">{f.noCommercialQuote}</p> : (
            <ul className="qx-quote-list">
              {commercialData.quotes.map(quote => (
                <li key={quote.id}>
                  <div>
                    <strong>{formatMoney(quote.amountMinor, quote.currency, lang)}</strong>
                    <p className="muted">{f.quoteExpires} {stamp(lang, quote.expiresAt)}</p>
                  </div>
                  {quote.accepted
                    ? <span className="badge success">{f.quoteAccepted}</span>
                    : quote.expired
                      ? <span className="badge neutral">{f.quoteExpired}</span>
                      : <AcceptQuoteForm lang={lang} operationId={op.id} quoteId={quote.id} idempotencyKey={crypto.randomUUID()} />}
                </li>
              ))}
            </ul>
          )}
          {commercialData.order ? (
            <p><span className="qx-kicker">{f.orderLabel}</span> <StatusBadge status={commercialData.order.state} lang={lang} /> {formatMoney(commercialData.order.amountMinor, commercialData.order.currency, lang)}</p>
          ) : null}
          {commercialData.payment.required ? <Feedback error title={f.paymentRequired} /> : null}
          {commercialData.executionAuthorized ? <p className="qx-ready">✓ {f.scopeAccepted}</p> : null}
          <p className="muted qx-hint">{f.quoteNote}</p>
        </>
      )}
    </Card>
  );

  const claimsCard = (
    <Card id="flow-review">
      <SectionHeading
        title={f.claimsTitle}
        note={f.claimsIntro}
        action={op.status === 'WAITING_APPROVAL' ? <ReassembleForm lang={lang} operationId={op.id} /> : null}
      />
      {!claimsData ? unavailable(claims.code) : claimsData.length === 0 ? <p className="muted">{f.claimsEmpty}</p> : (
        <ul className="qx-claim-list">
          {claimsData.map(claim => (
            <li key={claim.id}>
              <div className="qx-claim-head">
                <StatusBadge status={claim.status} lang={lang} />
                <span className="muted">{claim.kind} · {stamp(lang, claim.createdAt)}</span>
              </div>
              <p>{claim.statement}</p>
              {op.status === 'WAITING_APPROVAL' ? <ClaimReviewForm lang={lang} operationId={op.id} claimId={claim.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  const executionCard = (
    <Card id="flow-execution">
      <SectionHeading title={f.executionTitle} note={f.progressLabel + ': ' + completedSteps + ' / ' + stepCount} />
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={f.progressLabel}>
        <span style={{ width: progress + '%' }} />
      </div>
      {summaryData
        ? <p className="muted">{m.approvals}: {summaryData.pendingApprovals} · {m.steps}: {summaryData.completedSteps} / {summaryData.stepCount}</p>
        : unavailable(summary.code)}
      {canInterrupt ? (
        <ChangeForm lang={lang} label={m.interrupt} fields={{ kind: 'interrupt', id: op.id, version: String(op.version) }}>
          <p className="muted">{m.interruptNote}</p>
          <label className="qx-check"><input type="checkbox" name="confirm" required /> <span>{m.confirm}</span></label>
        </ChangeForm>
      ) : null}
    </Card>
  );

  const resultsCard = (
    <Card id="flow-results">
      <SectionHeading title={f.resultsTitle} />
      {!documentsData ? unavailable(documents.code) : resultDocuments.length === 0 ? <EmptyState title={f.resultsNone} mark="◫" /> : (
        <ul className="document-list">
          {resultDocuments.map(doc => (
            <li key={doc.id}>
              <Link href={'/' + lang + '/missions/' + op.id + '/results/' + encodeURIComponent(doc.id)}>{doc.title}</Link>
              <span className="muted"> · {m.version} {doc.version} · </span>
              <StatusBadge status={doc.status} lang={lang} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  const cards: { key: string; node: ReactNode }[] = [];
  const push = (key: string, node: ReactNode) => cards.push({ key, node });
  if (op.status === 'COMPLETED') {
    push('results', resultsCard);
    push('claims', claimsCard);
    push('plan', planCard);
    push('commercial', commercialCard);
    push('execution', executionCard);
    push('readiness', readinessCard);
  } else if (['DRAFT', 'READY', 'INTERRUPTED', 'FAILED'].includes(op.status)) {
    push('readiness', readinessCard);
    push('plan', planCard);
    push('commercial', commercialCard);
    push('claims', claimsCard);
    push('execution', executionCard);
    push('results', resultsCard);
  } else {
    push('plan', planCard);
    push('execution', executionCard);
    push('claims', claimsCard);
    push('commercial', commercialCard);
    push('results', resultsCard);
    push('readiness', readinessCard);
  }

  function prerequisiteChecks(data: NonNullable<typeof readinessData>) {
    return [
    { label: f.prereq.plan, ok: data.prerequisites.plan.ok, missing: [] },
    { label: f.prereq.capability, ok: data.prerequisites.capability.ok, missing: data.prerequisites.capability.missing },
    { label: f.prereq.offer, ok: data.prerequisites.offer.ok, missing: [] },
    { label: f.prereq.order, ok: data.prerequisites.order.ok, missing: [] },
    { label: f.prereq.budget, ok: data.prerequisites.budget.ok, missing: [] },
    { label: f.prereq.permission, ok: data.prerequisites.permission.ok, missing: [] },
    { label: f.prereq.engine, ok: data.prerequisites.engine.ok, missing: data.prerequisites.engine.missing },
    { label: f.prereq.orchestrator, ok: data.prerequisites.orchestrator.ok, missing: data.prerequisites.orchestrator.missing },
    { label: f.prereq.profile, ok: data.prerequisites.profile.ok, missing: data.prerequisites.profile.missing },
    { label: f.prereq.provider, ok: data.prerequisites.provider.ok, missing: data.prerequisites.provider.missing },
    ];
  }

  return (
    <AppShell lang={lang} active="missions" path={'missions/' + op.id}>
      <nav className="qx-breadcrumb" aria-label={t.back}><Link href={'/' + lang + '/mydash'}>← {t.back}</Link></nav>
      <FlowHeader lang={lang} model={model} refresh={<RefreshMission lang={lang} />} />
      <FlowWorkspace lang={lang} model={model} watermark={summaryData?.lastSequence ?? null} historyHref={requestedAfter===undefined&&cursor>0?'/'+lang+'/missions/'+id.data+'?after=0':null} decision={approvalsCard ?? undefined}>
        {cards.map(card => <Fragment key={card.key}>{card.node}</Fragment>)}
      </FlowWorkspace>
    </AppShell>
  );
}
