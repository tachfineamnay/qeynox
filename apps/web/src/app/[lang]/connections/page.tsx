import { AppShell, Card, EmptyState, Feedback, PageHeader } from '../../../components/ui';
import { api, ApiError, session } from '../../../lib/api';
import { copy, locale } from '../../../lib/copy';
import { connectionCopy } from '../../../lib/connection-copy';
import { ConnectionViewSchema, ConnectionAuditSchema, type ConnectionView, type ConnectionAudit } from '../../../lib/connections';
import { ConnectButton, DisconnectButton, RefreshButton } from '../../../components/connection-controls';

export const dynamic = 'force-dynamic';

const STATE_TONES: Record<string, string> = {
  CONNECTED: 'success', EXPIRING_SOON: 'warning', EXPIRED: 'warning',
  ERROR: 'danger', REVOKED: 'neutral', CONNECT_REQUIRED: 'info', NOT_CONFIGURED: 'neutral',
};

function fmt(value: string | null, lang: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC';
}

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lang = locale((await params).lang);
  const t = copy[lang];
  const c = connectionCopy(lang);
  const query = await searchParams;
  const current = await session();
  const configured = Boolean(process.env.QEYNOX_API_URL);
  let providers: ConnectionView[] | null = null;
  let audit: ConnectionAudit[] | null = null;
  let failure = '';
  if (current && configured) {
    try {
      providers = ConnectionViewSchema.parse(await api('/v1/connections'));
      audit = ConnectionAuditSchema.parse(await api('/v1/connections/audit?limit=15'));
    } catch (error) {
      failure = error instanceof ApiError ? error.code : 'UNAVAILABLE';
    }
  }
  const connectedFlag = typeof query.connected === 'string' ? query.connected : '';
  const errorFlag = typeof query.error === 'string' ? query.error : '';
  const failureText = failure === 'DENIED' ? t.denied : failure === 'NOT_CONFIGURED' ? t.notConfigured : failure === 'SESSION_REQUIRED' ? t.signInRequired : t.error;
  const outcomeLabel = (outcome: string) => c.outcomes[outcome] ?? outcome;

  return (
    <AppShell lang={lang} active="connections">
      <PageHeader eyebrow={t.eyebrow} title={c.title} description={c.intro} />

      {connectedFlag ? <Feedback title={c.connectedNotice} /> : null}
      {errorFlag ? <Feedback error title={c.errorNotice}>{errorFlag}</Feedback> : null}
      {!configured ? <Feedback title={t.notConfigured} /> : !current ? (
        <Feedback title={t.signInRequired}><a href={'/' + lang + '/account'}>{t.signin} →</a></Feedback>
      ) : failure ? (
        <Card><Feedback error title={failureText}>{failure}</Feedback></Card>
      ) : null}

      {providers ? (
        <>
          <p className="muted">{c.configuredHint}</p>
          <ul className="qx-connection-grid">
            {providers.map(provider => (
              <li key={provider.provider} className="qx-connection-card" data-state={provider.state}>
                <div className="qx-connection-head">
                  <h2>{provider.label}</h2>
                  <span className={'badge ' + (STATE_TONES[provider.state] ?? 'neutral')}>{c.states[provider.state] ?? provider.state}</span>
                </div>
                <p className="muted">{provider.purpose}</p>
                {provider.reason ? <Feedback error title={provider.reason} /> : null}

                <dl className="qx-connection-meta">
                  <div><dt>{c.requestedScopes}</dt><dd>{provider.requestedScopes.length ? provider.requestedScopes.join(' ') : '—'}</dd></div>
                  <div><dt>{c.grantedScopes}</dt><dd>{provider.grantedScopes.length ? provider.grantedScopes.join(' ') : c.noScopes}</dd></div>
                  <div><dt>{c.capabilities}</dt><dd>{provider.capabilities.length ? provider.capabilities.join(', ') : c.noScopes}</dd></div>
                  {provider.state === 'CONNECTED' || provider.state === 'EXPIRING_SOON' || provider.state === 'EXPIRED' ? (
                    <>
                      <div><dt>{c.expiry}</dt><dd>{fmt(provider.accessTokenExpiresAt, lang)}</dd></div>
                      <div><dt>{c.healthCheck}</dt><dd>{fmt(provider.lastHealthCheckAt, lang)}</dd></div>
                      <div><dt>{c.connectedBy}</dt><dd>{provider.connectedBy ?? '—'}</dd></div>
                      <div><dt>{c.connectedAt}</dt><dd>{fmt(provider.connectedAt, lang)}</dd></div>
                      {provider.lastErrorCode ? <div><dt>{c.lastError}</dt><dd><code>{provider.lastErrorCode}</code></dd></div> : null}
                    </>
                  ) : null}
                </dl>

                <div className="qx-connection-actions">
                  {provider.state === 'NOT_CONFIGURED' ? (
                    <p className="muted">{c.notConfiguredHint}</p>
                  ) : (
                    <>
                      {(provider.state === 'CONNECTED' || provider.state === 'EXPIRING_SOON' || provider.state === 'ERROR') ? (
                        <DisconnectButton lang={lang} provider={provider.provider} label={c.disconnect} />
                      ) : null}
                      {(provider.state === 'EXPIRED' || provider.state === 'ERROR') ? (
                        <RefreshButton lang={lang} provider={provider.provider} label={c.refresh} />
                      ) : null}
                      {provider.state !== 'CONNECTED' ? (
                        <ConnectButton lang={lang} provider={provider.provider} label={provider.state === 'CONNECT_REQUIRED' ? c.connect : c.reconnect} />
                      ) : null}
                    </>
                  )}
                </div>
                {provider.state === 'CONNECT_REQUIRED' ? <p className="muted">{provider.reason?.startsWith('Authorization started') ? c.pendingHint : c.envHint}</p> : null}
                {provider.state === 'REVOKED' ? <p className="muted">{c.revokeHint}</p> : null}
                {(provider.state === 'EXPIRED' || provider.state === 'ERROR') ? <p className="muted">{provider.state === 'EXPIRED' ? c.revokeHint : c.repairHint}</p> : null}
              </li>
            ))}
          </ul>

          <Card>
            <h2>{c.auditTitle}</h2>
            <p className="muted">{c.auditIntro}</p>
            {audit && audit.length ? (
              <table className="qx-table">
                <thead><tr><th scope="col">{c.auditAt}</th><th scope="col">{c.auditAction}</th><th scope="col">{c.auditOutcome}</th><th scope="col">{c.auditReason}</th></tr></thead>
                <tbody>
                  {audit.map(entry => (
                    <tr key={entry.id}><td>{fmt(entry.happenedAt, lang)}</td><td><code>{entry.action}</code></td><td>{outcomeLabel(entry.outcome)}</td><td>{entry.reason ?? '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : <EmptyState title={c.auditEmpty} mark="◇" />}
          </Card>
        </>
      ) : null}
    </AppShell>
  );
}
