import Link from 'next/link';
import type { Locale } from '../../lib/copy';
import { copy } from '../../lib/copy';
import { flowCopy } from '../../lib/flow-copy';
import { stamp } from '../../lib/flow-format';
import { missionCopy } from '../../lib/mission-copy';
import { eventKindLabel } from './event-label';
import type { FlowModel } from './types';

function Progress({ lang, model }: { lang: Locale; model: FlowModel }) {
  const c = flowCopy(lang).now;
  if (!model.now.progress) {
    return <p className="qx-flow-hint">{c.progressUnavailable}</p>;
  }
  const value = Math.round((model.now.progress.completed / model.now.progress.total) * 100);
  return (
    <div className="qx-now-progress">
      <p className="qx-kicker">{c.progressTitle}</p>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={c.progressTitle}>
        <span style={{ width: value + '%' }} />
      </div>
      <p className="muted">{model.now.progress.completed} / {model.now.progress.total} {c.progressText}</p>
    </div>
  );
}

/** Current work canvas: the highest-value recorded state, derived from server data only. */
export function NowCanvas({ lang, model, decisionShown, onSelectApproval }: { lang: Locale; model: FlowModel; decisionShown?: boolean; onSelectApproval?: (approvalId: string) => void }) {
  const c = flowCopy(lang).now;
  const h = flowCopy(lang).header;
  const f = missionCopy(lang).flow;
  const m = missionCopy(lang);
  const statuses = copy[lang].statuses as Record<string, string>;
  const guidance = missionCopy(lang).guidance as Record<string, string>;
  const reason = missionCopy(lang).reasons as Record<string, string>;
  const latestEvent = model.events.items[0] ?? null;
  let title = c.idleTitle;
  let body = c.idleBody;
  if (model.now.kind === 'approval') { title = c.approvalTitle; body = c.approvalBody; }
  else if (model.now.kind === 'running') { title = c.runningTitle; body = c.runningBody; }
  else if (model.now.kind === 'interruption') { title = c.interruptionTitle; body = c.interruptionBody; }
  else if (model.now.kind === 'preparation') { title = c.preparationTitle; body = model.readiness.canStart ? c.preparationReady : c.preparationBlocked; }
  else if (model.now.kind === 'recovery') { title = c.recoveryTitle; body = c.recoveryBody; }
  else if (model.now.kind === 'result') { title = c.resultTitle; body = c.resultBody; }
  return (
    <section className="qx-now" aria-labelledby="flow-now-title">
      <div className="qx-now-head">
        <div>
          <p className="qx-kicker">{c.kicker}</p>
          <h2 id="flow-now-title">{title}</h2>
          <p className="muted">{body}</p>
        </div>
        <span className={'badge ' + (model.operation.status === 'WAITING_APPROVAL' ? 'warning' : 'info')}>{statuses[model.operation.status] ?? model.operation.status}</span>
      </div>

      {model.now.kind === 'approval' && !decisionShown ? (
        model.now.approval ? (
          <div className="qx-now-decision">
            <p><span className="qx-kicker">{c.approvalPurpose}</span> {model.now.approval.purpose}</p>
            <p className="muted">{c.approvalExpires}: {stamp(lang, model.now.approval.expiresAt)}</p>
            {model.now.approval.stale ? <p className="qx-not-ready">{c.approvalStale}</p> : null}
            <div className="qx-now-actions">
              <Link className="button secondary qx-small" href="#flow-approvals">{c.approvalLink}</Link>
              {onSelectApproval ? <button type="button" className="qx-inline-link" onClick={() => onSelectApproval(model.now.approval!.id)}>{c.inspectApproval}</button> : null}
            </div>
          </div>
        ) : (
          <div className="qx-now-decision">
            <p className="qx-not-ready">{c.approvalUnreadable}</p>
            <Link className="button secondary qx-small" href="#flow-approvals">{c.approvalLink}</Link>
          </div>
        )
      ) : null}

      {model.now.kind === 'running' || model.now.kind === 'interruption' ? (
        model.now.activeStep ? (
          <div className="qx-now-step">
            <p className="qx-kicker">{c.activeStep}</p>
            <h3>{model.now.activeStep.title}</h3>
            <p className="muted">{c.capability}: {model.now.activeStep.capabilityName}</p>
            <p className="muted">
              {c.attempt}: #{model.now.activeStep.latestAttempt?.sequence ?? '—'} · {f.stepStates[(model.now.activeStep.latestAttempt?.state ?? model.now.activeStep.state) as keyof typeof f.stepStates] ?? (model.now.activeStep.latestAttempt?.state ?? model.now.activeStep.state)}
              {model.now.activeStep.latestAttempt?.startedAt ? ' · ' + c.startedAt + ' ' + stamp(lang, model.now.activeStep.latestAttempt.startedAt) : ''}
            </p>
          </div>
        ) : (
          <p className="qx-flow-hint">{c.noActiveAttempt}</p>
        )
      ) : null}

      {model.now.kind === 'preparation' ? (
        <div className="qx-now-preparation">
          {!model.readiness.planPresent ? <p className="qx-not-ready">{c.preparationNoPlan}</p> : null}
          {model.readiness.blockers > 0 ? <p className="muted">{model.readiness.blockers} {c.blockers}</p> : null}
          <div className="qx-now-actions">
            <Link className="button secondary qx-small" href="#flow-launch">{c.preparationLink}</Link>
            <Link className="button secondary qx-small" href="#flow-plan">{c.preparationPlanLink}</Link>
          </div>
        </div>
      ) : null}

      {model.now.kind === 'recovery' ? (
        <div className="qx-now-recovery">
          {model.operation.lastErrorCode ? <p className="qx-error-code">{f.lastError}: <code>{model.operation.lastErrorCode}</code></p> : null}
          <Link className="button secondary qx-small" href="#flow-launch">{c.recoveryLink}</Link>
        </div>
      ) : null}

      {model.now.kind === 'result' ? (
        <div className="qx-now-result">
          {model.now.document ? (
            <>
              <p><Link href={model.now.document.href}>{model.now.document.title}</Link> · {statuses[model.now.document.status] ?? model.now.document.status} · {h.version} {model.now.document.version}</p>
              {model.now.document.findings.length > 0 && <div><h3>{m.findings}</h3><ul>{model.now.document.findings.map(finding => <li key={finding.claimId}>{finding.statement} · {statuses[finding.status] ?? finding.status}{finding.citations.length > 0 && <> · {finding.citations.map(citation => citation.provider).join(', ')}</>}</li>)}</ul></div>}
              {model.now.document.limitations.length > 0 && <div><h3>{m.limits}</h3><ul>{model.now.document.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></div>}
              <Link className="button secondary qx-small" href="#flow-results">{c.resultLink}</Link>
            </>
          ) : <p className="qx-flow-hint">{model.now.resultCount > 0 ? c.resultMissing : c.resultEmpty}</p>}
        </div>
      ) : null}

      {(model.now.kind === 'running' || model.now.kind === 'preparation' || model.now.kind === 'interruption') ? <Progress lang={lang} model={model} /> : null}

      <div className="qx-now-grid">
        <div className="qx-now-cell">
          <p className="qx-kicker">{c.lastEvent}</p>
          {latestEvent ? (
            <p className="qx-now-event">
              <time dateTime={latestEvent.occurredAt}>{stamp(lang, latestEvent.occurredAt)}</time>
              <span>{eventKindLabel(lang, latestEvent.kind)}</span>
              <code>{latestEvent.kind}</code>
            </p>
          ) : <p className="muted">{c.noEvent}</p>}
        </div>
        <div className="qx-now-cell">
          <p className="qx-kicker">{c.pilotTitle}</p>
          {model.pilot.state.status === 'available' && model.pilot.action ? (
            <>
              <p className="qx-now-pilot">{guidance[model.pilot.action] ?? model.pilot.action}</p>
              {model.pilot.reason ? <p className="muted">{reason[model.pilot.reason] ?? model.pilot.reason}</p> : null}
            </>
          ) : <p className="muted">{c.pilotUnavailable} {model.pilot.state.code ? <code>{model.pilot.state.code}</code> : null}</p>}
        </div>
      </div>
    </section>
  );
}
