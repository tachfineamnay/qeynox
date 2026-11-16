'use client';
import type { Locale } from '../../lib/copy';
import { copy } from '../../lib/copy';
import { flowCopy } from '../../lib/flow-copy';
import { missionCopy } from '../../lib/mission-copy';
import type { FlowModel, FlowPhase, FlowSelection } from './types';

const ANCHORS: Record<FlowPhase['id'], string> = {
  FRAME: '#flow-launch',
  EXECUTE: '#flow-plan',
  REVIEW: '#flow-review',
  RESULT: '#flow-results',
};

/** Phase rail: recorded phases plus the real steps of the recorded plan. No phase or progress is inferred. */
export function PhaseRail({ lang, model, selection, onSelectStep }: {
  lang: Locale;
  model: FlowModel;
  selection: FlowSelection | null;
  onSelectStep: (stepId: string) => void;
}) {
  const f = flowCopy(lang);
  const m = missionCopy(lang).flow;
  const statuses = copy[lang].statuses as Record<string, string>;
  const phaseMeta = (phase: FlowPhase): string => {
    if (phase.id === 'FRAME') {
      return model.planRevision !== null ? f.phases.revisionLabel + ' ' + model.planRevision : f.phases.noSteps;
    }
    if (phase.id === 'EXECUTE') {
      if (phase.totalSteps === 0) return f.phases.noSteps;
      return f.phases.stepsLabel + ': ' + phase.completedSteps + ' / ' + phase.totalSteps;
    }
    if (phase.id === 'REVIEW') {
      const approvals = f.phases.approvalsLabel + ': ' + phase.pendingApprovals;
      if (model.claims.state.status === 'available' || model.claims.state.status === 'empty') {
        return approvals + ' · ' + f.phases.claimsLabel + ': ' + model.claims.count;
      }
      return approvals;
    }
    const documents = f.phases.documentsLabel + ': ' + phase.documentCount;
    return phase.resultStatus ? documents + ' · ' + (statuses[phase.resultStatus] ?? phase.resultStatus) : documents;
  };
  return (
    <nav className="qx-phase-rail" aria-label={f.phases.label}>
      <ol className="qx-phase-list">
        {model.phases.map((phase, index) => (
          <li key={phase.id} className={'qx-phase' + (phase.id === 'EXECUTE' && model.steps.length > 0 ? ' has-steps' : '')} data-state={phase.state}>
            <a className="qx-phase-head" href={ANCHORS[phase.id]}>
              <span className="qx-phase-index" aria-hidden="true">{index + 1}</span>
              <span className="qx-phase-copy">
                <span className="qx-phase-label">{f.phases[phase.id]}</span>
                <span className="qx-phase-meta">{phaseMeta(phase)}</span>
              </span>
              <span className="qx-phase-state" data-state={phase.state}>
                <span className="qx-status-dot" aria-hidden="true" />
                {f.phases.states[phase.state]}
              </span>
            </a>
            {phase.id === 'EXECUTE' && model.steps.length > 0 ? (
              <ol className="qx-phase-steps" aria-label={f.phases.stepsLabel}>
                {model.steps.map(step => (
                  <li key={step.id}>
                    <button
                      type="button"
                      className="qx-step-chip"
                      data-state={step.state}
                      aria-pressed={selection?.kind === 'step' && selection.id === step.id}
                      onClick={() => onSelectStep(step.id)}
                    >
                      <span className="qx-step-chip-index" aria-hidden="true">{step.ordinal}</span>
                      <span className="qx-step-chip-title">{step.title}</span>
                      <span className="qx-sr-only">{m.stepStates[step.state as keyof typeof m.stepStates] ?? step.state}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
