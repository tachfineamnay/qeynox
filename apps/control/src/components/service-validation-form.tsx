'use client';
import { useActionState } from 'react';
import { validateServiceAction } from '../lib/actions';
import { copy, type Locale } from '../lib/copy';
import type { ServiceValidationState } from '../lib/actions';

const initialState: ServiceValidationState = { status: 'idle' };

/**
 * Service validation preview: read-only check of one offer + capability pair against the live
 * configuration. The platform API re-checks permission and audits the call; nothing is created,
 * modified or activated. The report names every BLOCKER with its remedy, and reports the
 * iteration basis it used (or that none exists) — it never invents one.
 */
export function ServiceValidationForm({ lang, workspaceId }: { lang: Locale; workspaceId: string }) {
  const t = copy[lang];
  const [state, action, pending] = useActionState(validateServiceAction, initialState);
  const report = state.status === 'done' ? state.report : undefined;
  return (
    <form action={action} className="card form">
      <h2>{t.configurationValidateServiceTitle}</h2>
      <p className="muted">{t.configurationValidateServiceHint}</p>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="expectedProvider" value="world-bank" />
      <div className="inline-form">
        <label className="field"><span>{t.configurationCapability}</span>
          <input name="capabilityId" type="text" required minLength={2} maxLength={120} pattern="[A-Za-z0-9_.:\-]+" placeholder="capability-slot-8-v1" autoComplete="off" />
        </label>
        <label className="field"><span>{t.configurationOffer}</span>
          <input name="offerId" type="text" required minLength={2} maxLength={120} pattern="[A-Za-z0-9_.:\-]+" placeholder="offer-world-bank-research" autoComplete="off" />
        </label>
      </div>
      <div className="actions">
        <button className="button secondary" type="submit" disabled={pending}>{pending ? t.loading : t.configurationValidateServiceSubmit}</button>
      </div>
      {state.status === 'error' ? (
        <div className="notice danger" role="alert">
          <strong>{t.resultError}</strong>
          <p>{t.apiCode + ': ' + (state.code ?? 'UNAVAILABLE')}</p>
          {state.code === 'NOT_CONFIGURED' ? <p>{t.configurationHintNotConfigured}</p> : null}
        </div>
      ) : null}
      {report ? (
        <div className={'notice ' + (report.valid ? 'success' : 'warning')} role="status">
          <strong>{report.valid ? t.configurationValidateValid : t.configurationValidateBlocked}</strong>
          <p className="muted">{t.configurationValidateIterations}: {report.maximumIterations ?? t.configurationValidateNoProfile}</p>
          {report.findings.length ? (
            <table>
              <thead><tr><th>{t.configurationValidateCode}</th><th>{t.configurationValidateSeverity}</th><th>{t.configurationValidateDetail}</th><th>{t.configurationValidateRemedy}</th></tr></thead>
              <tbody>
                {report.findings.map((finding, index) => (
                  <tr key={finding.code + ':' + index}><td><code>{finding.code}</code></td><td>{finding.severity}</td><td>{finding.detail}</td><td>{finding.remedy}</td></tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
