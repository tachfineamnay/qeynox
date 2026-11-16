'use client';
import type { Locale } from '../../lib/copy';
import { flowCopy } from '../../lib/flow-copy';
import { stamp } from '../../lib/flow-format';
import { missionCopy } from '../../lib/mission-copy';
import type { FlowModel, FlowSelection } from './types';

/** Only capabilities with a server-recorded running/waiting attempt; no invented agent identity. */
export function AgentActivity({ lang, model, selection, onSelect }: {
  lang: Locale;
  model: FlowModel;
  selection: FlowSelection | null;
  onSelect: (selection: FlowSelection) => void;
}) {
  const c = flowCopy(lang).agents;
  const f = missionCopy(lang).flow;
  const stateLabel = (state: string) => (f.stepStates as Record<string, string>)[state] ?? state;
  return (
    <section className="qx-flow-panel qx-agents" aria-labelledby="flow-agents-title">
      <div className="qx-panel-head">
        <h2 id="flow-agents-title">{c.title}</h2>
        <span className="badge info">{model.agents.length} {c.countLabel}</span>
      </div>
      <p className="qx-panel-note">{c.note}</p>
      {model.agents.length === 0 ? (
        <p className="qx-panel-empty">{c.empty}</p>
      ) : (
        <ul className="qx-agent-list">
          {model.agents.map(agent => {
            const active = selection?.kind === 'agent' && selection.id === agent.id;
            const state = agent.attemptState ?? agent.stepState;
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  className="qx-agent-item"
                  aria-pressed={active}
                  onClick={() => onSelect({ kind: 'agent', id: agent.id })}
                  aria-label={c.select + ': ' + agent.capabilityName + ' — ' + stateLabel(state)}
                >
                  <span className="qx-agent-mark" data-state={state} aria-hidden="true">{agent.waitingApproval ? '!' : '›'}</span>
                  <span className="qx-agent-copy">
                    <strong>{agent.capabilityName}</strong>
                    <span className="qx-agent-step">{agent.stepTitle}</span>
                    <span className="qx-agent-meta">
                      {agent.waitingApproval ? c.waiting : stateLabel(state)}
                      {agent.attemptSequence !== null ? ' · ' + c.attempt + ' #' + agent.attemptSequence : ''}
                      {agent.startedAt ? ' · ' + c.since + ' ' + stamp(lang, agent.startedAt) : ''}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="qx-panel-foot">{c.capabilityNote}</p>
    </section>
  );
}
