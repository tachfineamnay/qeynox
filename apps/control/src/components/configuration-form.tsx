'use client';
import { useActionState } from 'react';
import { configureAction } from '../lib/actions';
import { copy, type Locale } from '../lib/copy';
import type { ConfigurationActionState } from '../lib/types';

const initialState: ConfigurationActionState = { status: 'idle' };

export function ConfigurationForm({ lang, workspaceId, idempotencyKey }: { lang: Locale; workspaceId: string; idempotencyKey: string }) {
  const t = copy[lang];
  const [state, action, pending] = useActionState(configureAction, initialState);
  const done = state.status === 'done' ? state.result : undefined;
  return (
    <form action={action} className="card form configuration-form">
      <h2>{t.configurationChangeTitle}</h2>
      <p className="muted">{t.configurationChangeHint}</p>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <label className="field"><span>{t.idempotencyKey}</span>
        <input name="idempotencyKey" type="text" required minLength={8} maxLength={200} pattern="[A-Za-z0-9_.:\-]+" defaultValue={idempotencyKey} autoComplete="off" />
      </label>
      <label className="field"><span>{t.entriesLabel}</span>
        <textarea name="entries" required minLength={2} maxLength={200000} rows={16} className="mono" spellCheck={false}
          placeholder={'[\n  { "domain": "TOOL", "connectorId": "acme-invoice", "version": "1.0.0", "status": "ACTIVE", "manifest": { "description": "…", "provider": "Acme", "regions": ["eu-west-1"], "operations": ["read"], "mode": "READ_ONLY", "licenseNotes": "…", "freshness": { "ttlSeconds": 3600, "publishedAtSource": "PROVIDER" }, "rateLimit": { "maxPerMinute": 60 }, "tools": [{ "name": "fetch_invoice", "version": "1.0.0" }] } }\n]'} />
      </label>
      <label className="field"><span>{t.justification}</span>
        <textarea name="reason" required minLength={10} maxLength={500} rows={3} />
      </label>
      <label className="confirm"><input type="checkbox" name="confirm" /><span>{t.confirmApply}</span></label>
      <div className="actions">
        <button className="button secondary" type="submit" name="mode" value="preview" disabled={pending}>{pending ? t.loading : t.previewConfiguration}</button>
        <button className="button" type="submit" name="mode" value="apply" disabled={pending}>{pending ? t.loading : t.applyConfiguration}</button>
      </div>
      {state.status === 'error' ? (
        <div className="notice danger" role="alert">
          <strong>{t.resultError}</strong>
          <p>{t.apiCode + ': ' + (state.code ?? 'UNAVAILABLE')}</p>
          {state.code === 'CONFIRMATION_REQUIRED' ? <p>{t.configurationHintConfirmation}</p> : null}
          {state.code === 'NOT_CONFIGURED' ? <p>{t.configurationHintNotConfigured}</p> : null}
          {state.code === 'CONFLICT' ? <p>{t.configurationHintConflict}</p> : null}
          {state.code === 'DENIED' ? <p>{t.configurationHintDenied}</p> : null}
        </div>
      ) : null}
      {done ? (
        <div className="notice success" role="status">
          <strong>{done.dryRun ? t.configurationPreviewReady : t.configurationApplied}</strong>
          {done.alreadyApplied ? <p>{t.configurationAlreadyApplied}</p> : null}
          <p className="muted">{t.configurationDigest + ': ' + done.digest.slice(0, 16) + '…'}</p>
          {done.changes.length ? (
            <table>
              <thead><tr><th>{t.configurationDomain}</th><th>{t.configurationKey}</th><th>{t.configurationVersion}</th><th>{t.configurationOutcome}</th></tr></thead>
              <tbody>
                {done.changes.map(change => (
                  <tr key={change.domain + ':' + change.key + ':' + change.version}><td>{change.domain}</td><td><code>{change.key}</code></td><td>{change.version}</td><td>{change.outcome}</td></tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
