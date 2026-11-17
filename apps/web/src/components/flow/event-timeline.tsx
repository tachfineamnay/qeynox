'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { Locale } from '../../lib/copy';
import { flowCopy } from '../../lib/flow-copy';
import { stamp } from '../../lib/flow-format';
import { eventKindLabel } from './event-label';
import type { FlowModel, FlowSelection } from './types';

/** Persisted events ordered by the server sequence; a new recorded event may briefly mark its row. */
export function EventTimeline({ lang, model, selection, onSelect }: {
  lang: Locale;
  model: FlowModel;
  selection: FlowSelection | null;
  onSelect: (selection: FlowSelection) => void;
}) {
  const c = flowCopy(lang).timeline;
  const availability = flowCopy(lang).availability;
  const latestId = model.events.items[0]?.eventId ?? null;
  const latestSequence = model.events.items[0]?.sequence ?? null;
  const lastSeen = useRef({ sequence: latestSequence, page: typeof window === 'undefined' ? '' : window.location.search, operation: model.operation.id });
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => {
    const page = window.location.search;
    const previous = lastSeen.current;
    lastSeen.current = { sequence: latestSequence, page, operation: model.operation.id };
    if (latestId && latestSequence !== null && previous.sequence !== null && latestSequence > previous.sequence && page === previous.page && model.operation.id === previous.operation && !new URLSearchParams(page).has('after')) {
      setHighlight(latestId);
      const timer = window.setTimeout(() => setHighlight(null), 220);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [latestId, latestSequence, model.operation.id]);
  const state = model.events.state;
  return (
    <section className="qx-flow-panel qx-timeline" aria-labelledby="flow-timeline-title">
      <div className="qx-panel-head">
        <h2 id="flow-timeline-title">{c.title}</h2>
        <span className="badge neutral">{model.events.items.length}</span>
      </div>
      <p className="qx-panel-note">{c.note}</p>
      {state.status !== 'available' && state.status !== 'empty' ? (
        <p className="qx-panel-error" role="status">
          {c.unavailable} <code>{state.code ?? state.status}</code> · {availability[state.status]}
        </p>
      ) : null}
      {model.events.items.length === 0 ? (
        <p className="qx-panel-empty">{c.empty}</p>
      ) : (
        <ol className="qx-event-list">
          {model.events.items.map((event, index) => {
            const active = selection?.kind === 'event' && selection.id === event.eventId;
            const label = eventKindLabel(lang, event.kind);
            return (
              <li key={event.eventId} className={highlight === event.eventId ? 'is-new' : undefined}>
                <button
                  type="button"
                  className="qx-event-row"
                  aria-pressed={active}
                  onClick={() => onSelect({ kind: 'event', id: event.eventId })}
                  aria-label={c.select + ': ' + label + ' — ' + stamp(lang, event.occurredAt)}
                >
                  <span className="qx-event-marker" aria-hidden="true" />
                  <span className="qx-event-copy">
                    <span className="qx-event-kind">
                      {label}
                      {index === 0 ? <span className="qx-event-latest">{c.latest}</span> : null}
                    </span>
                    <code className="qx-event-code">{event.kind}</code>
                    <time className="qx-event-time" dateTime={event.occurredAt}>{stamp(lang, event.occurredAt)}</time>
                  </span>
                  <span className="qx-event-seq">{c.sequence} {event.sequence}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {model.events.duplicates > 0 ? <p className="qx-panel-foot">{model.events.duplicates + ' ' + c.duplicates}</p> : null}
      {model.events.moreHref ? <Link className="button secondary qx-small qx-timeline-more" href={model.events.moreHref}>{c.more}</Link> : null}
    </section>
  );
}
