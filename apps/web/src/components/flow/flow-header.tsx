import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Locale } from '../../lib/copy';
import { flowCopy } from '../../lib/flow-copy';
import { stamp } from '../../lib/flow-format';
import { StatusBadge } from '../ui';
import type { FlowModel } from './types';

const FALLBACK_STATUSES: Record<string, string> = {};

/** Compact objective-first header: recorded mission state, real counts and the relevant next views. */
export function FlowHeader({ lang, model, refresh }: { lang: Locale; model: FlowModel; refresh: ReactNode }) {
  const f = flowCopy(lang).header;
  const planRead = model.readStates.find(entry => entry.id === 'plan')?.state;
  const steps = model.summary.stepCount !== null && model.summary.completedSteps !== null
    ? model.summary.completedSteps + ' / ' + model.summary.stepCount
    : null;
  const objective = model.objective.statement;
  const objectiveMissing = planRead?.status === 'error' || planRead?.status === 'denied' ? f.objectiveUnavailable : f.objectiveMissing;
  const readLabels = flowCopy(lang).reads as Record<string, string>;
  const staleLabels = model.staleReads.map(id => readLabels[id] ?? id);
  return (
    <header className="qx-flow-head">
      <div className="qx-flow-head-bar qx-flow-desktop-details">
        <p className="eyebrow">{f.eyebrow}</p>
        <div className="qx-flow-head-tools">{refresh}</div>
      </div>
      <div className="qx-flow-head-main">
        <div className="qx-flow-head-copy">
          <h1 id="flow-mission-title">{objective ?? model.operation.title}</h1>
          {objective ? <p className="qx-flow-head-subtitle">{model.operation.title}</p> : null}
          <div className="qx-meta-row">
            <StatusBadge status={model.operation.status} lang={lang} />
            <span className="qx-flow-desktop-details muted">{f.version} {model.operation.version}</span>
            <span className="qx-flow-desktop-details muted">{f.updated}: {stamp(lang, model.operation.lastActivityAt)}</span>
            {steps !== null ? <span className="qx-flow-desktop-details muted">{f.steps}: {steps}</span> : null}
            {model.pendingApprovals.length > 0 ? <span className="qx-flow-desktop-details badge warning">{f.pendingApprovals}: {model.pendingApprovals.length}</span> : null}
          </div>
          {!objective ? <p className="muted qx-flow-head-note">{objectiveMissing}</p> : null}
          {model.operation.lastErrorCode ? (
            <p className="qx-error-code">{f.lastError}: <code>{model.operation.lastErrorCode}</code></p>
          ) : null}
        </div>
        <nav className="qx-flow-head-links qx-flow-desktop-details" aria-label={f.eyebrow}>
          <Link className="button secondary qx-small" href="#flow-plan">{f.openPlan}</Link>
          <Link className="button secondary qx-small" href="#flow-results">{f.openResults}</Link>
        </nav>
      </div>
      {model.objective.constraints.length > 0 ? (
        <div className="qx-flow-head-constraints qx-flow-desktop-details">
          <span className="qx-kicker">{f.constraints}</span>
          <ul className="qx-chip-list">
            {model.objective.constraints.map((constraint, position) => <li key={position}>{constraint}</li>)}
          </ul>
        </div>
      ) : null}
      <details className="qx-flow-mobile-details">
        <summary>{lang === 'fr' ? 'Détails de la mission' : 'Mission details'}</summary>
        <p className="muted">{f.version} {model.operation.version} · {f.updated}: {stamp(lang, model.operation.lastActivityAt)}{steps !== null ? ` · ${f.steps}: ${steps}` : ''}</p>
        {model.pendingApprovals.length > 0 && <p>{f.pendingApprovals}: {model.pendingApprovals.length}</p>}
        {model.objective.constraints.length > 0 && <p>{f.constraints}: {model.objective.constraints.join(' · ')}</p>}
        <nav className="qx-flow-head-links" aria-label={f.eyebrow}><Link className="button secondary qx-small" href="#flow-plan">{f.openPlan}</Link><Link className="button secondary qx-small" href="#flow-results">{f.openResults}</Link></nav>
      </details>
      {model.staleReads.length > 0 ? (
        <div className="qx-flow-stale" role="status">
          <strong>{f.staleTitle}</strong>
          <p>{f.staleBody}</p>
          <p className="qx-flow-stale-reads"><span className="qx-kicker">{f.staleTitle}:</span> {staleLabels.join(' · ')}</p>
        </div>
      ) : null}
    </header>
  );
}
