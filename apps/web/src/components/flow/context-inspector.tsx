'use client';
import Link from 'next/link';
import type { Locale } from '../../lib/copy';
import { copy } from '../../lib/copy';
import { flowCopy } from '../../lib/flow-copy';
import { stamp } from '../../lib/flow-format';
import { missionCopy } from '../../lib/mission-copy';
import { StatusBadge } from '../ui';
import { eventKindLabel } from './event-label';
import type { FlowAttempt, FlowModel, FlowSelection } from './types';

const ACTIVE_ATTEMPT = new Set(['RUNNING', 'WAITING_APPROVAL']);

interface InspectorAction { key: string; label: string; href: string; available: boolean; reason: string }

const READ_TONES: Record<string, string> = {
  available: 'info', empty: 'neutral', loading: 'neutral', denied: 'danger', error: 'danger', stale: 'warning',
};

function ActionList({ title, actions }: { title: string; actions: InspectorAction[] }) {
  if (actions.length === 0) return null;
  return (
    <div className="qx-inspector-block">
      <h4>{title}</h4>
      <ul className="qx-action-list">
        {actions.map(action => (
          <li key={action.key} data-available={action.available ? 'true' : 'false'}>
            <span className="qx-action-mark" aria-hidden="true">{action.available ? '✓' : '!'}</span>
            {action.available
              ? <Link href={action.href}>{action.label}</Link>
              : <span><span>{action.label}</span><span className="muted"> {action.reason}</span></span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Contextual inspector: recorded details, provenance, availability and actions for the selection. */
export function ContextInspector({ lang, model, selection, compact, onClear, onClose }: {
  lang: Locale;
  model: FlowModel;
  selection: FlowSelection | null;
  compact: boolean;
  onClear: () => void;
  onClose?: () => void;
}) {
  const c = flowCopy(lang).inspector;
  const f = missionCopy(lang).flow;
  const availability = flowCopy(lang).availability;
  const stateLabel = (state: string) => (f.stepStates as Record<string, string>)[state] ?? state;
  const statusLabels = copy[lang].statuses as Record<string, string>;
  const readLabels = flowCopy(lang).reads as Record<string, string>;
  const readLabel = (id: string) => readLabels[id] ?? id;

  const step = selection?.kind === 'step' ? model.steps.find(item => item.id === selection.id) ?? null : null;
  const agent = selection?.kind === 'agent' ? model.agents.find(item => item.id === selection.id) ?? null : null;
  const event = selection?.kind === 'event' ? model.events.items.find(item => item.eventId === selection.id) ?? null : null;
  const approval = selection?.kind === 'approval' ? model.approvals.find(item => item.id === selection.id) ?? null : null;
  const agentStep = agent ? model.steps.find(item => item.id === agent.stepId) ?? null : null;
  const selectedStep = step ?? agentStep;
  const missing = Boolean(selection) && !step && !agent && !event && !approval;

  const stepActions: InspectorAction[] = selectedStep ? [
    {
      key: 'redo',
      label: c.actionRedo,
      href: '#flow-plan',
      available: model.gates.redo && Boolean(selectedStep.latestAttempt) && !ACTIVE_ATTEMPT.has(selectedStep.latestAttempt?.state ?? ''),
      reason: c.actionRedoUnavailable,
    },
    {
      key: 'edit',
      label: c.actionEdit,
      href: '#flow-plan',
      available: model.gates.editPlan,
      reason: c.actionEditUnavailable,
    },
    {
      key: 'evidence',
      label: c.actionEvidence,
      href: '#flow-review',
      available: model.claims.state.status === 'available' || model.claims.state.status === 'empty',
      reason: c.actionNone,
    },
    {
      key: 'approval',
      label: c.actionApproval,
      href: '#flow-approvals',
      available: model.gates.decideApproval,
      reason: c.actionApprovalUnavailable,
    },
  ] : [];

  const attemptLine = (attempt: FlowAttempt) => (
    <li key={attempt.attemptId}>
      <strong>#{attempt.sequence}</strong> · {stateLabel(attempt.state)}
      <span className="muted"> · {c.createdAt} {stamp(lang, attempt.createdAt)}</span>
      {attempt.startedAt ? <span className="muted"> · {c.startedAt} {stamp(lang, attempt.startedAt)}</span> : null}
      {attempt.finishedAt ? <span className="muted"> · {c.finishedAt} {stamp(lang, attempt.finishedAt)}</span> : null}
      {attempt.errorCode ? <span className="qx-error-code"> · {c.attemptError}: <code>{attempt.errorCode}</code></span> : null}
    </li>
  );

  return (
    <section id="flow-inspector" className="qx-flow-panel qx-inspector" aria-labelledby="flow-inspector-title" tabIndex={-1}>
      <div className="qx-inspector-head">
        <h2 id="flow-inspector-title">{c.title}</h2>
        {onClose ? (
          <button type="button" className="qx-icon-button qx-inspector-close" data-inspector-close onClick={onClose} aria-label={c.close}>✕</button>
        ) : null}
      </div>
      {compact && onClose ? <p className="qx-panel-foot">{c.closeHint}</p> : null}

      {missing ? (
        <div className="qx-inspector-block">
          <p className="qx-not-ready">{c.selectionMissing}</p>
          <button type="button" className="secondary qx-small" onClick={onClear}>{c.clear}</button>
        </div>
      ) : null}

      {!selection || missing ? (
        <>
          {!missing ? <p className="qx-panel-note">{c.hint}</p> : null}
          <div className="qx-inspector-block">
            <h3>{c.missionTitle}</h3>
            <dl className="qx-detail-grid">
              <div><dt>{c.objective}</dt><dd>{model.objective.statement ?? flowCopy(lang).header.objectiveMissing}</dd></div>
              <div><dt>{c.constraints}</dt><dd>{model.objective.constraints.length > 0 ? model.objective.constraints.join(' · ') : flowCopy(lang).header.noConstraints}</dd></div>
            </dl>
          </div>
          <div className="qx-inspector-block">
            <h3>{c.consentTitle}</h3>
            <p>
              {model.context.consent.state === 'granted'
                ? c.consentGranted
                : model.context.consent.state === 'not_granted'
                  ? c.consentNotGranted
                  : c.consentUnavailable}
              {model.context.consent.code ? <code> ({model.context.consent.code})</code> : null}
            </p>
            <p className="muted">{model.context.facts.length} {c.factsCount}</p>
            {model.context.factsState.status !== 'available' && model.context.factsState.status !== 'empty' ? (
              <p className="qx-panel-error">{availability[model.context.factsState.status]} <code>{model.context.factsState.code ?? model.context.factsState.status}</code></p>
            ) : model.context.facts.length === 0 ? <p className="qx-panel-empty">{c.noFacts}</p> : (
              <ul className="qx-context-list">
                {model.context.facts.map(fact => (
                  <li key={fact.id}>
                    <span className="qx-fact-key">{fact.key}</span>
                    {fact.value ? <span className="qx-fact-value">{fact.value}</span> : null}
                    <span className="qx-fact-time">{c.factUpdated} {stamp(lang, fact.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="qx-panel-foot">{c.contextNote}</p>
            <Link className="button secondary qx-small" href={'/' + lang + '/soul'}>{c.openSoul} →</Link>
          </div>
          <div className="qx-inspector-block">
            <h3>{c.readsTitle}</h3>
            <p className="qx-panel-note">{c.readsNote}</p>
            <ul className="qx-read-list">
              {model.readStates.map(entry => (
                <li key={entry.id} data-status={entry.state.status}>
                  <span>{readLabel(entry.id)}</span>
                  <span className={'badge ' + (READ_TONES[entry.state.status] ?? 'neutral')}>
                    {availability[entry.state.status]}
                    {entry.state.code ? ' · ' + entry.state.code : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      {selection && selectedStep ? (
        <>
          <div className="qx-inspector-heading">
            <p className="qx-kicker">{c.step}</p>
            <h3>{selectedStep.title}</h3>
            <StatusBadge status={selectedStep.state} lang={lang} />
          </div>
          <div className="qx-inspector-block">
            <dl className="qx-detail-grid">
              <div><dt>{c.state}</dt><dd>{stateLabel(selectedStep.state)}</dd></div>
              <div><dt>{c.capability}</dt><dd>{selectedStep.capabilityName}</dd></div>
              <div><dt>{c.purpose}</dt><dd>{selectedStep.capabilityPurpose || flowCopy(lang).common.none}</dd></div>
              <div><dt>{c.intent}</dt><dd>{(f.intent as Record<string, string>)[selectedStep.intent] ?? selectedStep.intent}</dd></div>
              <div><dt>{c.dependencies}</dt><dd>{selectedStep.dependsOn.length > 0 ? selectedStep.dependsOn.map(dependency => dependency.title).join(', ') : c.noDependencies}</dd></div>
              <div><dt>{c.description}</dt><dd>{selectedStep.description}</dd></div>
            </dl>
          </div>
          <div className="qx-inspector-block">
            <h4>{c.attempts}</h4>
            {selectedStep.attempts.length > 0
              ? <ol className="qx-attempt-list">{selectedStep.attempts.map(attemptLine)}</ol>
              : <p className="qx-panel-empty">{c.noAttempts}</p>}
          </div>
          {agent ? (
            <div className="qx-inspector-block">
              <dl className="qx-detail-grid">
                <div><dt>{c.agentAttempt}</dt><dd>{agent.attemptSequence !== null ? '#' + agent.attemptSequence + ' · ' + stateLabel(agent.attemptState ?? agent.stepState) : flowCopy(lang).common.none}</dd></div>
                <div><dt>{c.agentExternal}</dt><dd>{agent.capabilityExternalActions ? flowCopy(lang).agents.external : flowCopy(lang).agents.noExternal}</dd></div>
                <div><dt>{c.agentStarted}</dt><dd>{agent.startedAt ? stamp(lang, agent.startedAt) : flowCopy(lang).common.none}</dd></div>
              </dl>
            </div>
          ) : null}
          <ActionList title={c.actionsTitle} actions={stepActions} />
          <div className="qx-inspector-block">
            <button type="button" className="secondary qx-small" onClick={onClear}>{c.clear}</button>
          </div>
        </>
      ) : null}

      {selection && event ? (
        <>
          <div className="qx-inspector-heading">
            <p className="qx-kicker">{c.eventKind}</p>
            <h3>{eventKindLabel(lang, event.kind)}</h3>
          </div>
          <div className="qx-inspector-block">
            <dl className="qx-detail-grid">
              <div><dt>{c.eventKind}</dt><dd>{eventKindLabel(lang, event.kind)} <code>{event.kind}</code></dd></div>
              <div><dt>{c.eventOccurred}</dt><dd>{stamp(lang, event.occurredAt)}</dd></div>
              <div><dt>{c.eventSequence}</dt><dd>{event.sequence}</dd></div>
              <div><dt>{c.envelopeId}</dt><dd><code>{event.id}</code></dd></div>
              <div><dt>{c.eventId}</dt><dd><code>{event.eventId}</code></dd></div>
            </dl>
            <p className="qx-panel-foot">{c.eventNote}</p>
            <button type="button" className="secondary qx-small" onClick={onClear}>{c.clear}</button>
          </div>
        </>
      ) : null}

      {selection && approval ? (
        <>
          <div className="qx-inspector-heading">
            <p className="qx-kicker">{c.approvalPurpose}</p>
            <h3>{approval.purpose}</h3>
            <StatusBadge status={approval.status} lang={lang} />
          </div>
          <div className="qx-inspector-block">
            <dl className="qx-detail-grid">
              <div><dt>{c.approvalState}</dt><dd>{statusLabels[approval.status] ?? approval.status}</dd></div>
              <div><dt>{c.approvalExpires}</dt><dd>{stamp(lang, approval.expiresAt)}</dd></div>
              <div><dt>{c.approvalAttempt}</dt><dd><code>{approval.attemptId}</code></dd></div>
            </dl>
            {approval.stale ? <p className="qx-not-ready">{c.approvalStale}</p> : null}
            <ActionList title={c.actionsTitle} actions={[{
              key: 'approval',
              label: c.actionApproval,
              href: '#flow-approvals',
              available: model.gates.decideApproval && approval.pending && !approval.stale,
              reason: c.actionApprovalUnavailable,
            }]} />
            <button type="button" className="secondary qx-small" onClick={onClear}>{c.clear}</button>
          </div>
        </>
      ) : null}

      <div className="qx-inspector-block qx-provenance">
        <h4>{c.provenance}</h4>
        <p className="qx-panel-foot">{c.provenanceNote}</p>
      </div>
    </section>
  );
}
