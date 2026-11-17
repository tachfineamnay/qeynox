'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Locale } from '../../lib/copy';
import { flowCopy } from '../../lib/flow-copy';
import { AgentActivity } from './agent-activity';
import { ContextInspector } from './context-inspector';
import { EventTimeline } from './event-timeline';
import { NowCanvas } from './now-canvas';
import { PhaseRail } from './phase-rail';
import type { FlowModel, FlowSelection } from './types';

/**
 * Client composition boundary: keeps selection state and the compact inspector drawer.
 * All displayed business data is rendered from the server-provided FlowModel; no fetch happens here.
 */
export function FlowWorkspace({ lang, model, decision, children }: {
  lang: Locale;
  model: FlowModel;
  decision?: ReactNode;
  children: ReactNode;
}) {
  const c = flowCopy(lang).inspector;
  const [selection, setSelection] = useState<FlowSelection | null>(null);
  const [compact, setCompact] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const inspectorShell = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 1439px)');
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => (returnFocus.current ?? triggerRef.current)?.focus());
  }, []);

  useEffect(() => {
    if (!compact) { setOpen(false); return undefined; }
    if (!open) return undefined;
    const node = inspectorShell.current;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    node?.querySelector<HTMLElement>('[data-inspector-close]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab' || !node) return;
      const focusable = node.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) { event.preventDefault(); node.focus(); return; }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    node?.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      node?.removeEventListener('keydown', onKeyDown);
    };
  }, [compact, open, close]);

  useEffect(() => {
    if (!selection || compact) return;
    inspectorShell.current?.scrollIntoView({ block: 'nearest' });
  }, [selection, compact]);

  const select = useCallback((next: FlowSelection) => {
    setSelection(next);
    if (compact) { returnFocus.current = document.activeElement as HTMLElement; setOpen(true); }
  }, [compact]);

  const compactOpen = compact && open;
  const shellClass = 'qx-inspector-shell' + (compact ? ' is-compact' : '') + (compactOpen ? ' is-open' : '');
  return (
    <div className="qx-flow-shell">
      <div className="qx-flow-rail">
        <PhaseRail lang={lang} model={model} selection={selection} onSelectStep={stepId => select({ kind: 'step', id: stepId })} />
      </div>
      <div className="qx-flow-center">
        {decision ? <div className="qx-flow-decision">{decision}</div> : null}
        <NowCanvas lang={lang} model={model} decisionShown={Boolean(decision)} onSelectApproval={approvalId => select({ kind: 'approval', id: approvalId })} />
        <AgentActivity lang={lang} model={model} selection={selection} onSelect={select} />
        {children}
      </div>
      <div className="qx-flow-aside">
        <div ref={inspectorShell} className={shellClass} inert={compact && !open} aria-hidden={compact && !open} role={compactOpen ? 'dialog' : undefined} aria-modal={compactOpen ? true : undefined} aria-labelledby={compactOpen ? 'flow-inspector-title' : undefined}>
          <ContextInspector lang={lang} model={model} selection={selection} compact={compact} onClear={() => setSelection(null)} onClose={compact ? close : undefined} />
        </div>
        <EventTimeline lang={lang} model={model} selection={selection} onSelect={select} />
      </div>
      <button ref={triggerRef} type="button" className="qx-inspector-trigger" aria-expanded={open} aria-controls="flow-inspector" onClick={() => { returnFocus.current = triggerRef.current; setOpen(true); }}>
        {open ? c.close : c.open}
      </button>
      {compactOpen ? <div className="qx-inspector-backdrop" onClick={close} aria-hidden="true" /> : null}
    </div>
  );
}
