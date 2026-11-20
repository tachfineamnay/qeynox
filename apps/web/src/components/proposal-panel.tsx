'use client';
import { useRef, useState } from 'react';
import { proposePlan } from '../lib/plan-actions';
import { missionCopy } from '../lib/mission-copy';
import type { Locale } from '../lib/copy';
import { Feedback } from './ui';
import type { PlanProposalResult, ProposalStep } from '../lib/proposal';
import { formatMoney } from '../lib/money';

export interface ProposalApply {
  title: string;
  description: string;
  capabilityId: string;
  intent: ProposalStep['intent'];
  dependsOnIndices: number[];
  expectedDeliverable: string;
}

type Stage =
  | { name: 'idle' }
  | { name: 'loading' }
  | { name: 'unavailable'; code: string }
  | { name: 'questions'; proposal: PlanProposalResult; answers: string[] }
  | { name: 'preview'; proposal: PlanProposalResult };

/**
 * Pilot plan proposal: ask, review, edit, then decide. Everything rendered here is advisory —
 * nothing is saved, sealed, approved or executed from this panel. The editor below (and the
 * customer's explicit save) remains the only path to a plan.
 */
export function ProposalPanel({ lang, operationId, onApply }: {
  lang: Locale;
  operationId: string;
  onApply: (steps: ProposalApply[]) => void;
}) {
  const f = missionCopy(lang).flow;
  const [stage, setStage] = useState<Stage>({ name: 'idle' });
  const keyRef = useRef<string>(crypto.randomUUID());

  const submit = async (answers?: { question: string; answer: string }[]) => {
    keyRef.current = crypto.randomUUID(); // every submit is a fresh attempt; the cache replays only true retries of the same key
    const attemptKey = keyRef.current;
    setStage({ name: 'loading' });
    const result = await proposePlan({ operationId, locale: lang, attemptKey, answers: answers ?? [] });
    if (result.code !== 'OK' || !result.proposal) {
      setStage({ name: 'unavailable', code: result.code });
      return;
    }
    const proposal = result.proposal;
    if (proposal.reason !== 'OK' || proposal.steps.length === 0) {
      setStage({ name: 'unavailable', code: proposal.reason });
      return;
    }
    if (proposal.questions.length > 0 && !answers) {
      setStage({ name: 'questions', proposal, answers: proposal.questions.map(() => '') });
      return;
    }
    setStage({ name: 'preview', proposal });
  };

  if (stage.name === 'loading') {
    return <p className="muted qx-proposal" role="status">{f.proposalWorking}</p>;
  }

  if (stage.name === 'idle') {
    return (
      <section className="qx-proposal qx-proposal-idle" aria-label={f.proposalTitle}>
        <h4>{f.proposalTitle}</h4>
        <p className="muted qx-hint">{f.proposalIntro}</p>
        <button type="button" className="secondary" onClick={() => void submit()}>{f.proposalButton}</button>
      </section>
    );
  }

  if (stage.name === 'unavailable') {
    return (
      <Feedback error title={f.proposalUnavailable}>
        <p>{f.proposalUnavailableHint}</p>
        <p className="muted">{f.proposalCannotSave} <span className="qx-code">({stage.code})</span></p>
        <button type="button" className="secondary" onClick={() => setStage({ name: 'idle' })}>{f.proposalButton}</button>
      </Feedback>
    );
  }

  if (stage.name === 'questions') {
    const proposal = stage.proposal;
    const send = (skip: boolean) => {
      const questions = proposal.questions;
      const answers = skip ? [] : questions.map((q, i) => ({ question: q, answer: (stage.answers[i] ?? '').trim() })).filter(a => a.answer.length > 0);
      if (skip) setStage({ name: 'preview', proposal });
      else void submit(answers); // fresh key: answers change the draft, they must not hit the previous cached attempt
    };
    return (
      <section className="qx-proposal qx-proposal-questions" aria-label={f.proposalQuestionsTitle}>
        <h4>{f.proposalQuestionsTitle}</h4>
        <p className="muted qx-hint">{f.proposalQuestionsIntro}</p>
        <ol className="qx-proposal-question-list">
          {proposal.questions.map((question, index) => (
            <li key={index}>
              <label htmlFor={'proposal-q-' + index}>{question}</label>
              <input id={'proposal-q-' + index} value={stage.answers[index] ?? ''} maxLength={2000}
                placeholder={f.proposalAnswerPlaceholder}
                onChange={event => setStage(current => current.name === 'questions'
                  ? { ...current, answers: current.answers.map((value, i) => (i === index ? event.target.value : value)) }
                  : current)} />
            </li>
          ))}
        </ol>
        <div className="qx-button-row">
          <button type="button" className="secondary" onClick={() => send(false)}>{f.proposalSubmitAnswers}</button>
          <button type="button" onClick={() => send(true)}>{f.proposalSkipAnswers}</button>
        </div>
      </section>
    );
  }

  const proposal = stage.proposal;
  const readinessLabel = (state: string) =>
    state === 'OPERATIONAL' ? f.proposalStateOperational : state === 'BLOCKED' ? f.proposalStateBlocked : state === 'UNVERIFIED' ? f.proposalStateUnverified : f.proposalStateConfigured;
  return (
    <section className="qx-proposal qx-proposal-preview" aria-label={f.proposalTitle}>
      <h4>{f.proposalTitle}</h4>
      {proposal.summary ? <p><span className="qx-kicker">{f.proposalSummary}</span> {proposal.summary}</p> : null}
      <p className="muted qx-hint">{f.proposalSavedHint}</p>
      {proposal.deliverables.length > 0 ? (
        <div>
          <h5>{f.proposalDeliverables}</h5>
          <ul>{proposal.deliverables.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </div>
      ) : null}
      {proposal.assumptions.length > 0 ? (
        <div>
          <h5>{f.proposalAssumptions}</h5>
          <ul>{proposal.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </div>
      ) : null}
      <ol className="qx-proposal-steps">
        {proposal.steps.map(step => (
          <li key={step.index}>
            <div className="qx-step-top">
              <span className="qx-step-index" aria-hidden="true">{step.index + 1}</span>
              <div className="qx-step-copy">
                <h3>{step.title}</h3>
                <p className="muted">{step.description}</p>
                <p className="muted qx-hint">→ {step.expectedDeliverable}</p>
              </div>
            </div>
          </li>
        ))}
      </ol>
      {proposal.capabilityNotes.length > 0 ? (
        <div>
          <h5>{f.proposalReadinessTitle}</h5>
          <ul className="qx-proposal-notes">
            {proposal.capabilityNotes.map(note => (
              <li key={note.capabilityId}>
                <strong>{note.name}</strong> · {readinessLabel(note.operationalState)}
                {!note.isExecutable && note.missingProviders.length > 0 ? <span className="muted"> — {note.missingProviders.join(', ')}</span> : null}
                {!note.isExecutable && note.missingPolicies.length > 0 ? <span className="muted"> — {note.missingPolicies.join(', ')}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <h5>{f.proposalBudgetTitle}</h5>
        {proposal.budget.configured
          ? <p className="muted">{f.proposalCeiling}: {proposal.budget.maxMoneyMinor !== undefined && proposal.budget.currency ? formatMoney(proposal.budget.maxMoneyMinor, proposal.budget.currency, lang) : '—'}
              {proposal.budget.maxAgentCalls !== undefined ? ' · ' + f.proposalAgentCalls + ': ' + proposal.budget.maxAgentCalls : ''}
              {proposal.budget.maxToolCalls !== undefined ? ' · ' + f.proposalToolCalls + ': ' + proposal.budget.maxToolCalls : ''}
              {proposal.budget.maxDurationSeconds !== undefined ? ' · ' + f.proposalWallTime + ': ' + proposal.budget.maxDurationSeconds : ''}</p>
          : <p className="muted">{f.proposalBudgetUnknown}</p>}
      </div>
      {proposal.requiresApproval ? <p className="qx-not-ready">{f.proposalApprovalNote}</p> : null}
      <div className="qx-button-row">
        <button type="button" className="secondary" onClick={() => onApply(proposal.steps.map(step => ({
          title: step.title, description: step.description, capabilityId: step.capabilityId,
          intent: step.intent, dependsOnIndices: step.dependsOnIndices, expectedDeliverable: step.expectedDeliverable,
        })))}>{f.proposalApply}</button>
        <button type="button" onClick={() => setStage({ name: 'idle' })}>{f.proposalDiscard}</button>
      </div>
    </section>
  );
}
