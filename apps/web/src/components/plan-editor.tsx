'use client';
import { useActionState, useState } from 'react';
import { savePlan } from '../lib/plan-actions';
import { missionCopy } from '../lib/mission-copy';
import type { Locale } from '../lib/copy';
import { errorText } from './forms';
import { Feedback } from './ui';

type Intent = 'RESEARCH' | 'ANALYZE' | 'VERIFY' | 'EXTERNAL_ACTION';
export type DraftStep = {
  key: string;
  title: string;
  description: string;
  capabilityId: string;
  intent: Intent;
  dependsOn: string[];
};
export type EditorCapability = {
  id: string;
  slot: number;
  name: string;
  purpose: string;
  externalActions: boolean;
};
const INTENTS: readonly Intent[] = ['RESEARCH', 'ANALYZE', 'VERIFY', 'EXTERNAL_ACTION'];

function emptyStep(key: string, capabilityId: string): DraftStep {
  return { key, title: '', description: '', capabilityId, intent: 'RESEARCH', dependsOn: [] };
}

/**
 * Writes a plan revision from configured capabilities only. The operator is the author and the
 * validator: no proposed plan is generated or simulated here.
 */
export function PlanEditor({ lang, operationId, version, mode, revisionId, capabilities, initialSteps }: {
  lang: Locale;
  operationId: string;
  version: number;
  mode: 'create' | 'revise';
  revisionId?: string;
  capabilities: readonly EditorCapability[];
  initialSteps: readonly DraftStep[];
}) {
  const f = missionCopy(lang).flow;
  const [steps, setSteps] = useState<DraftStep[]>([...initialSteps]);
  const [state, action, pending] = useActionState(savePlan, { code: '' });

  const patch = (key: string, change: Partial<DraftStep>) =>
    setSteps(current => current.map(step => (step.key === key ? { ...step, ...change } : step)));
  const move = (position: number, offset: number) => setSteps(current => {
    const target = position + offset;
    if (target < 0 || target >= current.length) return current;
    const next = [...current];
    const moved = next[position];
    const displaced = next[target];
    if (!moved || !displaced) return current;
    next[position] = displaced;
    next[target] = moved;
    return next;
  });
  const remove = (key: string) => setSteps(current =>
    current.filter(step => step.key !== key).map(step => ({ ...step, dependsOn: step.dependsOn.filter(dep => dep !== key) })));
  const add = () => setSteps(current => [
    ...current,
    emptyStep('new-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), capabilities[0]?.id ?? ''),
  ]);

  if (!capabilities.length) {
    return <Feedback title={f.capabilitiesTitle} error>{f.capabilitiesEmpty}</Feedback>;
  }

  return (
    <form action={action} className="qx-plan-editor">
      <input type="hidden" name="operationId" value={operationId} />
      <input type="hidden" name="locale" value={lang} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="mode" value={mode} />
      {mode === 'revise' && revisionId ? <input type="hidden" name="revisionId" value={revisionId} /> : null}
      <input type="hidden" name="steps" value={JSON.stringify(steps)} />

      {steps.length === 0 ? <p className="muted">{f.planNoneCopy}</p> : null}

      <ol className="qx-step-editor">
        {steps.map((step, position) => {
          const selected = capabilities.find(item => item.id === step.capabilityId);
          const unknown = !selected && step.capabilityId.length > 0;
          return (
            <li key={step.key} className="qx-step">
              <div className="qx-step-head">
                <span className="qx-step-index" aria-hidden="true">{position + 1}</span>
                <div className="qx-step-actions">
                  <button type="button" className="qx-icon-button" onClick={() => move(position, -1)} disabled={position === 0} aria-label={f.moveUp}>↑</button>
                  <button type="button" className="qx-icon-button" onClick={() => move(position, 1)} disabled={position === steps.length - 1} aria-label={f.moveDown}>↓</button>
                  <button type="button" className="qx-icon-button" onClick={() => remove(step.key)} aria-label={f.removeStep}>✕</button>
                </div>
              </div>
              <div className="qx-field">
                <label htmlFor={step.key + '-title'}>{f.stepTitleLabel}</label>
                <input id={step.key + '-title'} value={step.title} maxLength={180} required
                  onChange={event => patch(step.key, { title: event.target.value })} />
              </div>
              <div className="qx-field">
                <label htmlFor={step.key + '-description'}>{f.stepDescription}</label>
                <textarea id={step.key + '-description'} value={step.description} maxLength={3000} required rows={3}
                  onChange={event => patch(step.key, { description: event.target.value })} />
              </div>
              <div className="qx-step-grid">
                <div className="qx-field">
                  <label htmlFor={step.key + '-capability'}>{f.stepCapability}</label>
                  <select id={step.key + '-capability'} value={step.capabilityId} required
                    onChange={event => patch(step.key, { capabilityId: event.target.value })}>
                    {unknown ? <option value={step.capabilityId} disabled>{step.capabilityId + ' — ' + f.notConfigured}</option> : null}
                    {capabilities.map(capability => (
                      <option key={capability.id} value={capability.id}>
                        {capability.slot + '. ' + capability.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="qx-field">
                  <label htmlFor={step.key + '-intent'}>{f.stepIntent}</label>
                  <select id={step.key + '-intent'} value={step.intent}
                    onChange={event => patch(step.key, { intent: event.target.value as Intent })}>
                    {INTENTS.map(intent => (
                      <option key={intent} value={intent} disabled={intent === 'EXTERNAL_ACTION' && !(selected?.externalActions ?? false)}>
                        {f.intent[intent]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {position > 0 ? (
                <fieldset className="qx-deps">
                  <legend>{f.stepDepends}</legend>
                  {steps.slice(0, position).map(prior => (
                    <label key={prior.key} className="qx-check">
                      <input type="checkbox" checked={step.dependsOn.includes(prior.key)}
                        onChange={event => patch(step.key, {
                          dependsOn: event.target.checked
                            ? [...step.dependsOn, prior.key]
                            : step.dependsOn.filter(dep => dep !== prior.key),
                        })} />
                      <span>{prior.title.trim() || f.stepWord + ' ' + (steps.indexOf(prior) + 1)}</span>
                    </label>
                  ))}
                </fieldset>
              ) : <p className="muted qx-hint">{f.stepNoDepends}</p>}
            </li>
          );
        })}
      </ol>

      <div className="qx-button-row">
        <button type="button" className="secondary" onClick={add}>{f.addStep}</button>
      </div>

      {mode === 'revise' ? (
        <div className="qx-field">
          <label htmlFor="revise-reason">{f.reviseReason}</label>
          <input id="revise-reason" name="reason" minLength={3} maxLength={2000} required />
          <p className="muted qx-hint">{f.reviseReasonHint}</p>
        </div>
      ) : null}

      <label className="qx-check qx-plan-confirm"><input type="checkbox" name="planConfirm" required /> <span>{f.planConfirm}</span></label>

      <div className="form-bottom">
        <p className="muted">{mode === 'revise' ? f.stepWarning : f.planNoneCopy}</p>
        <button disabled={pending || steps.length === 0}>{pending ? missionCopy(lang).busy : (mode === 'revise' ? f.revisePlan : f.savePlan)}</button>
      </div>

      {state.code ? (
        <Feedback
          error={state.code !== 'OK'}
          title={state.code === 'OK' ? f.planSaved : errorText(state.code, lang) + ' (' + state.code + ')'}
        />
      ) : null}
    </form>
  );
}
