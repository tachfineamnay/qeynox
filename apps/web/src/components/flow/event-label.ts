import { flowCopy } from '../../lib/flow-copy';
import { copy, type Locale } from '../../lib/copy';

/** Persisted event kinds are localized when known; unknown kinds keep a neutral label and the raw code. */
export function eventKindLabel(lang: Locale, kind: string): string {
  const events = flowCopy(lang).events as Record<string, string>;
  const direct = events[kind];
  if (direct) return direct;
  if (kind.startsWith('OPERATION_')) {
    const status = kind.slice('OPERATION_'.length);
    const label = (copy[lang].statuses as Record<string, string>)[status];
    return events.operationStatus + ': ' + (label ?? status);
  }
  return flowCopy(lang).timeline.unknown;
}
