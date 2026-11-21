'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import type { AtlasArtifactSummary, ResultShareSummary } from '@qeynox/contracts';
import type { Locale } from '../lib/copy';
import { resultsCopy } from '../lib/results-copy';
import {
  artifactAction,
  createShareAction,
  revokeShareAction,
  type ArtifactActionState,
  type ShareActionState,
} from '../lib/result-share-actions';
import { errorText } from './forms';
import { Feedback } from './ui';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatUtc(lang: Locale, iso: string): string {
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return iso;
  return (
    new Intl.DateTimeFormat(lang, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(parsed) + ' UTC'
  );
}

function FormatExportButton({
  lang,
  operationId,
  documentId,
  format,
  disabled,
}: {
  lang: Locale;
  operationId: string;
  documentId: string;
  format: 'pdf' | 'html' | 'json';
  disabled: boolean;
}) {
  const r = resultsCopy[lang];
  const [state, action, pending] = useActionState<ArtifactActionState, FormData>(artifactAction, {
    code: '',
  });
  return (
    <form action={action} className="qx-export-unit">
      <input type="hidden" name="kind" value="export" />
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="operationId" value={operationId} />
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="format" value={format} />
      <button type="submit" disabled={disabled || pending}>
        {pending ? r.exportBusy : `${r.exportBtn} · ${format.toUpperCase()}`}
      </button>
      {state.url ? (
        <a className="button secondary qx-small" href={state.url} target="_blank" rel="noopener noreferrer">
          {r.openDownloadLink} ({format.toUpperCase()})
        </a>
      ) : null}
      {state.sha256 ? (
        <p className="muted qx-digest-line">
          {r.sha256Label}: <code>{state.sha256}</code>
        </p>
      ) : null}
      {state.code && state.code !== 'OK' ? (
        <Feedback title={`${errorText(state.code, lang)} (${state.code})`} error />
      ) : null}
    </form>
  );
}

function StoredArtifactGrantRow({
  lang,
  operationId,
  documentId,
  artifact,
  storageConfigured,
}: {
  lang: Locale;
  operationId: string;
  documentId: string;
  artifact: AtlasArtifactSummary;
  storageConfigured: boolean;
}) {
  const r = resultsCopy[lang];
  const [state, action, pending] = useActionState<ArtifactActionState, FormData>(artifactAction, {
    code: '',
  });
  return (
    <li className="qx-artifact-item">
      <div className="qx-artifact-meta">
        <div className="qx-meta-row">
          <strong>{artifact.format.toUpperCase()}</strong>
          <span
            className={`badge ${artifact.state === 'AVAILABLE' ? 'success' : 'warning'}`}
            data-status={artifact.state}
          >
            {artifact.state === 'AVAILABLE' ? r.artifactAvailable : r.artifactPending}
          </span>
          <span className="muted">{formatBytes(artifact.size)}</span>
          <span className="muted">{formatUtc(lang, artifact.createdAt)}</span>
        </div>
        <p className="muted qx-digest-line">
          {r.sha256Label}: <code>{artifact.sha256}</code>
        </p>
      </div>
      {artifact.state === 'AVAILABLE' ? (
        <form action={action} className="qx-artifact-grant-form">
          <input type="hidden" name="kind" value="grant" />
          <input type="hidden" name="lang" value={lang} />
          <input type="hidden" name="operationId" value={operationId} />
          <input type="hidden" name="documentId" value={documentId} />
          <input type="hidden" name="artifactId" value={artifact.id} />
          <button
            type="submit"
            className="secondary qx-small"
            disabled={!storageConfigured || pending}
          >
            {pending ? r.exportBusy : r.getSignedUrlBtn}
          </button>
          {state.url ? (
            <a
              className="button qx-small"
              href={state.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {r.openDownloadLink}
            </a>
          ) : null}
          {state.code && state.code !== 'OK' ? (
            <Feedback title={`${errorText(state.code, lang)} (${state.code})`} error />
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

export function ResultExportPanel({
  lang,
  operationId,
  documentId,
  artifacts,
  canExportNew,
  artifactStoreConfigured,
}: {
  lang: Locale;
  operationId: string;
  documentId: string;
  artifacts: readonly AtlasArtifactSummary[];
  canExportNew: boolean;
  artifactStoreConfigured: boolean;
}) {
  const r = resultsCopy[lang];
  const [reconcileState, reconcileAction, reconciling] = useActionState<
    ArtifactActionState,
    FormData
  >(artifactAction, { code: '' });
  const hasPending = artifacts.some(item => item.state === 'PENDING_UPLOAD');

  return (
    <div className="qx-export-panel">
      {!artifactStoreConfigured ? (
        <div className="qx-not-ready" role="status">
          <span aria-hidden="true">!</span>
          <span>{r.storageUnavailableNotice}</span>
        </div>
      ) : null}
      {!canExportNew ? <p className="muted">{r.exportSupersededNote}</p> : null}

      <div className="qx-export-grid">
        {(['pdf', 'html', 'json'] as const).map(format => (
          <FormatExportButton
            key={format}
            lang={lang}
            operationId={operationId}
            documentId={documentId}
            format={format}
            disabled={!artifactStoreConfigured || !canExportNew}
          />
        ))}
      </div>

      <div className="qx-artifact-section">
        <div className="qx-artifact-section-head">
          <h3>{r.existingArtifactsTitle}</h3>
          {hasPending ? (
            <form action={reconcileAction}>
              <input type="hidden" name="kind" value="reconcile" />
              <input type="hidden" name="lang" value={lang} />
              <input type="hidden" name="operationId" value={operationId} />
              <input type="hidden" name="documentId" value={documentId} />
              <button
                type="submit"
                className="secondary qx-small"
                disabled={!artifactStoreConfigured || reconciling}
              >
                {reconciling ? r.exportBusy : r.reconcileBtn}
              </button>
            </form>
          ) : null}
        </div>

        {reconcileState.code === 'OK' ? (
          <Feedback title={`${r.reconcileSuccess} (${reconcileState.recoveredCount ?? 0})`} />
        ) : reconcileState.code ? (
          <Feedback
            title={`${errorText(reconcileState.code, lang)} (${reconcileState.code})`}
            error
          />
        ) : null}

        {artifacts.length === 0 ? (
          <p className="muted">{r.noExistingArtifacts}</p>
        ) : (
          <ul className="qx-artifact-list">
            {artifacts.map(artifact => (
              <StoredArtifactGrantRow
                key={artifact.id}
                lang={lang}
                operationId={operationId}
                documentId={documentId}
                artifact={artifact}
                storageConfigured={artifactStoreConfigured}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RevokeShareButton({
  lang,
  documentId,
  shareId,
}: {
  lang: Locale;
  documentId: string;
  shareId: string;
}) {
  const r = resultsCopy[lang];
  const [state, action, pending] = useActionState<ShareActionState, FormData>(revokeShareAction, {
    code: '',
  });
  return (
    <form action={action} className="qx-inline-form">
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="shareId" value={shareId} />
      <button type="submit" className="secondary qx-small qx-danger-btn" disabled={pending}>
        {pending ? r.revokingShare : r.revokeShareBtn}
      </button>
      {state.code && state.code !== 'OK' ? (
        <span className="qx-error-code">
          {errorText(state.code, lang)} ({state.code})
        </span>
      ) : null}
    </form>
  );
}

export function ResultSharePanel({
  lang,
  documentId,
  isDeliverable,
  canManageShares,
  shares,
}: {
  lang: Locale;
  documentId: string;
  isDeliverable: boolean;
  canManageShares: boolean;
  shares: readonly ResultShareSummary[];
}) {
  const r = resultsCopy[lang];
  const [createState, createAction, creating] = useActionState<ShareActionState, FormData>(
    createShareAction,
    { code: '' },
  );
  const [copied, setCopied] = useState(false);

  if (!isDeliverable) {
    return (
      <div className="qx-not-ready" role="note">
        <span aria-hidden="true">!</span>
        <span>{r.shareLockedNotDeliverable}</span>
      </div>
    );
  }

  if (!canManageShares) {
    return (
      <div className="qx-not-ready" role="note">
        <span aria-hidden="true">!</span>
        <span>{r.shareLockedMemberRole}</span>
      </div>
    );
  }

  const fullShareUrl =
    createState.sharePath && typeof window !== 'undefined'
      ? `${window.location.origin}${createState.sharePath}`
      : createState.sharePath ?? '';

  const copyUrl = async () => {
    if (!fullShareUrl || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(fullShareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="qx-share-panel">
      <form action={createAction} className="qx-share-create-form">
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="documentId" value={documentId} />
        <div className="qx-share-fields">
          <div className="qx-field">
            <label htmlFor={`share-label-${documentId}`}>{r.shareLabelField}</label>
            <input
              id={`share-label-${documentId}`}
              name="label"
              type="text"
              maxLength={120}
              placeholder={r.shareLabelPlaceholder}
            />
          </div>
          <div className="qx-field">
            <label htmlFor={`share-expiry-${documentId}`}>{r.shareExpiryField}</label>
            <select id={`share-expiry-${documentId}`} name="expiresInHours" defaultValue="72">
              {Object.entries(r.shareExpiryOptions).map(([hours, text]) => (
                <option key={hours} value={hours}>
                  {text}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button type="submit" disabled={creating}>
          {creating ? r.creatingShare : r.createShareBtn}
        </button>
      </form>

      {createState.code === 'OK' && createState.sharePath ? (
        <div className="qx-share-once-box" role="status">
          <strong>{r.shareCreatedHeading}</strong>
          <p className="muted">{r.shareCreatedNote}</p>
          <div className="qx-share-url-row">
            <code className="qx-share-url">{fullShareUrl}</code>
            <button type="button" className="secondary qx-small" onClick={() => void copyUrl()}>
              {copied ? r.copiedShareBtn : r.copyShareBtn}
            </button>
            <Link className="button secondary qx-small" href={createState.sharePath}>
              {r.openSharedView}
            </Link>
          </div>
        </div>
      ) : createState.code ? (
        <Feedback
          title={`${errorText(createState.code, lang)} (${createState.code})`}
          error
        />
      ) : null}

      <div className="qx-share-list-section">
        <h3>{r.existingSharesTitle}</h3>
        {shares.length === 0 ? (
          <p className="muted">{r.noSharesYet}</p>
        ) : (
          <ul className="qx-share-list">
            {shares.map(share => {
              const tone =
                share.state === 'ACTIVE'
                  ? 'success'
                  : share.state === 'REVOKED'
                    ? 'danger'
                    : 'warning';
              return (
                <li key={share.id} className="qx-share-item">
                  <div className="qx-share-item-main">
                    <div className="qx-meta-row">
                      <strong>{share.label ?? r.shareUntitled}</strong>
                      <span className={`badge ${tone}`} data-status={share.state}>
                        {r.shareState[share.state]}
                      </span>
                    </div>
                    <p className="muted">
                      {r.shareCreatedCol}: {formatUtc(lang, share.createdAt)} · {r.shareExpiresCol}:{' '}
                      {formatUtc(lang, share.expiresAt)} · {r.shareAccessCol}: {share.accessCount}
                      {share.revokedAt ? ` · ${r.revokingShare.replace('…', '')}: ${formatUtc(lang, share.revokedAt)}` : ''}
                    </p>
                  </div>
                  {share.state === 'ACTIVE' ? (
                    <RevokeShareButton lang={lang} documentId={documentId} shareId={share.id} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
