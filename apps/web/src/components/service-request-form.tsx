'use client';
import { useActionState } from 'react';
import { serviceCopy } from '../lib/service-copy';
import { requestService, type ServiceRequestState } from '../lib/service-actions';
import { errorText } from './forms';
import { Feedback } from './ui';
import type { Locale } from '../lib/copy';
import { SERVICE_CONTRACT_WORLD_BANK } from '@qeynox/contracts';

const initialState: ServiceRequestState = { code: '' };

/**
 * Typed World Bank research request form. The server action re-validates everything; the API
 * re-checks the allowlist and creates the operation and plan. Nothing is quoted or executed here.
 */
export function ServiceRequestForm({ lang, offerId, disabled }: { lang: Locale; offerId: string; disabled?: boolean }) {
  const s = serviceCopy(lang);
  const [state, action, pending] = useActionState(requestService, initialState);
  const invalid = !disabled && state.code !== '';
  const message = invalid
    ? state.code === 'NOT_CONFIGURED'
      ? s.notConfigured
      : state.code === 'DENIED'
        ? s.denied
        : state.code === 'NOT_FOUND'
          ? s.notFound
          : state.code === 'INVALID_INPUT'
            ? s.invalid
            : errorText(state.code, lang)
    : '';
  return (
    <form action={action} className="qx-service-form">
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="service" value={SERVICE_CONTRACT_WORLD_BANK} />

      <label htmlFor="objective">{s.objective}</label>
      <p id="objective-hint" className="muted">{s.objectiveHint}</p>
      <textarea id="objective" name="objective" required minLength={20} maxLength={5000} rows={4} placeholder="e.g. Assess how GDP per capita evolved in Morocco across the last three published years" aria-describedby="objective-hint" disabled={disabled || pending} />

      <div className="qx-service-row">
        <div>
          <label htmlFor="country">{s.country}</label>
          <input id="country" name="country" required minLength={2} maxLength={3} autoComplete="off" placeholder="MAR" aria-describedby="country-hint" disabled={disabled || pending} />
          <span id="country-hint" className="muted">{s.countryHint}</span>
        </div>
        <div>
          <label htmlFor="indicator">{s.indicator}</label>
          <input id="indicator" name="indicator" required minLength={3} maxLength={64} autoComplete="off" placeholder="NY.GDP.PCAP.CD" aria-describedby="indicator-hint" disabled={disabled || pending} />
          <span id="indicator-hint" className="muted">{s.indicatorHint}</span>
        </div>
        <div>
          <label htmlFor="mostRecent">{s.mostRecent}</label>
          <select id="mostRecent" name="mostRecent" defaultValue="3" disabled={disabled || pending}>
            {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="minObservationYear">{s.minYear}</label>
          <input id="minObservationYear" name="minObservationYear" type="number" inputMode="numeric" min={1960} max={new Date().getUTCFullYear()} placeholder="2020" disabled={disabled || pending} />
        </div>
      </div>

      <div className="qx-service-row">
        <div>
          <label htmlFor="compare1">{s.compare1}</label>
          <input id="compare1" name="compare1" maxLength={64} autoComplete="off" placeholder="NY.GDP.MKTP.KD.ZG" disabled={disabled || pending} />
        </div>
        <div>
          <label htmlFor="compare2">{s.compare2}</label>
          <input id="compare2" name="compare2" maxLength={64} autoComplete="off" placeholder="SP.POP.TOTL" disabled={disabled || pending} />
        </div>
      </div>

      <label className="checkbox"><input type="checkbox" name="includeInterpretation" defaultChecked disabled={disabled || pending} /><span>{s.interpretation}</span></label>

      <label htmlFor="note">{s.note}</label>
      <textarea id="note" name="note" maxLength={500} rows={2} aria-describedby="note-hint" disabled={disabled || pending} />
      <p id="note-hint" className="muted">{s.constraintsNote}</p>

      <button type="submit" disabled={disabled || pending}>{pending ? s.working : s.submit}</button>
      {invalid ? <Feedback error title={message} /> : null}
    </form>
  );
}
