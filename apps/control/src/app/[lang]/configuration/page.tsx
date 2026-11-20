import { requirePlatformMe, tryApi } from '../../../lib/api';
import { copy, locale } from '../../../lib/copy';
import { can, MANAGE_CONFIGURATION, READ_CONFIGURATION } from '../../../lib/permissions';
import { ApiErrorNotice, Badge, Card, Empty, Notice, PageHeader, PermissionDenied, Shell } from '../../../components/shell';
import { ConfigurationForm } from '../../../components/configuration-form';
import type { PlatformConfigurationStateView } from '../../../lib/types';

function first(value: string | string[] | undefined): string { return typeof value === 'string' ? value.trim() : ''; }

function money(minor: number, currency: string, lang: string): string {
  try { return new Intl.NumberFormat(lang, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).format(minor / 100); }
  catch { return (minor / 100).toFixed(2) + ' ' + currency; }
}

export default async function ConfigurationPage({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lang = locale((await params).lang);
  const query = await searchParams;
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const canRead = can(me.permissions, READ_CONFIGURATION);
  const canManage = can(me.permissions, MANAGE_CONFIGURATION);
  const workspaceId = first(query.workspaceId);
  const requested = /^[A-Za-z0-9_-]{4,120}$/.test(workspaceId) ? workspaceId : '';
  const result = canRead && requested
    ? await tryApi<PlatformConfigurationStateView>('/v1/platform/configuration?workspaceId=' + encodeURIComponent(requested))
    : null;
  const state = result && result.ok ? result.value : null;
  const suggestedKey = 'control-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return (
    <Shell lang={lang} path="/configuration" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <PageHeader title={t.configurationTitle} intro={t.configurationIntro} actions={me.roles.map(role => <Badge key={role} tone="neutral">{role}</Badge>)} />
      {!canRead ? <PermissionDenied lang={lang} /> : null}
      {canRead ? (
        <>
          <Card>
            <form method="get" className="inline-form">
              <input type="hidden" name="lang" value={lang} />
              <label className="field"><span>{t.configurationWorkspaceLabel}</span>
                <input name="workspaceId" type="text" required minLength={4} maxLength={120} pattern="[A-Za-z0-9_\-]+" defaultValue={requested} placeholder="ws_…" autoComplete="off" />
              </label>
              <button className="button" type="submit">{t.configurationLoad}</button>
            </form>
            <p className="muted">{t.configurationWorkspaceHint}</p>
          </Card>

          {!requested ? <Card><Empty>{t.configurationNoWorkspace}</Empty></Card> : null}
          {result && !result.ok ? (
            result.code === 'NOT_CONFIGURED'
              ? <Notice tone="warning" title={t.configurationNotConfiguredTitle}>{t.configurationHintNotConfigured}</Notice>
              : <ApiErrorNotice lang={lang} code={result.code} />
          ) : null}

          {state ? (
            <>
              <Card>
                <h2>{t.configurationCapabilities}</h2>
                <div className="table-wrap"><table>
                  <thead><tr><th>{t.configurationSlot}</th><th>{t.status}</th><th>{t.configurationCapability}</th><th>{t.configurationVersion}</th><th>{t.configurationName}</th></tr></thead>
                  <tbody>
                    {state.capabilities.map(row => (
                      <tr key={row.slot}>
                        <td>#{row.slot}</td>
                        <td><Badge tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.status === 'ACTIVE' ? t.active : t.configurationUnconfigured}</Badge></td>
                        <td>{row.capabilityId ? <code>{row.capabilityId}</code> : '—'}</td>
                        <td>{row.version ?? '—'}</td>
                        <td>{row.name ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              </Card>

              <Card>
                <h2>{t.configurationProfiles}</h2>
                <div className="table-wrap"><table>
                  <thead><tr><th>{t.configurationRole}</th><th>{t.status}</th><th>{t.configurationProfile}</th><th>{t.configurationVersion}</th></tr></thead>
                  <tbody>
                    {state.profiles.map(row => (
                      <tr key={row.roleKey}>
                        <td><code>{row.roleKey}</code></td>
                        <td><Badge tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.status === 'ACTIVE' ? t.active : t.configurationUnconfigured}</Badge></td>
                        <td>{row.profileId ? <code>{row.profileId}</code> : '—'}</td>
                        <td>{row.version ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              </Card>

              <Card>
                <h2>{t.configurationTools}</h2>
                {state.tools.length === 0 ? <Empty>{t.configurationToolsEmpty}</Empty> : (
                  <div className="table-wrap"><table>
                    <thead><tr><th>{t.configurationConnector}</th><th>{t.configurationVersion}</th><th>{t.status}</th></tr></thead>
                    <tbody>
                      {state.tools.map(row => (
                        <tr key={row.connectorId + '@' + row.version}><td><code>{row.connectorId}</code></td><td>{row.version}</td><td><Badge tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.status}</Badge></td></tr>
                      ))}
                    </tbody>
                  </table></div>
                )}
              </Card>

              <Card>
                <h2>{t.configurationVerification}</h2>
                {state.verificationPolicies.length === 0 ? <Empty>{t.configurationVerificationEmpty}</Empty> : (
                  <div className="table-wrap"><table>
                    <thead><tr><th>{t.configurationCapability}</th><th>{t.configurationVersion}</th><th>{t.status}</th><th>{t.configurationMinSources}</th><th>{t.configurationProviders}</th></tr></thead>
                    <tbody>
                      {state.verificationPolicies.map(row => (
                        <tr key={row.capabilityId + '@' + row.version}><td><code>{row.capabilityId}</code></td><td>{row.version}</td><td><Badge tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.status}</Badge></td><td>{row.minimumSources}</td><td>{row.approvedProviders.join(', ')}</td></tr>
                      ))}
                    </tbody>
                  </table></div>
                )}
              </Card>

              <Card>
                <h2>{t.configurationOffers}</h2>
                {state.offers.length === 0 ? <Empty>{t.configurationOffersEmpty}</Empty> : (
                  <div className="table-wrap"><table>
                    <thead><tr><th>{t.configurationOffer}</th><th>{t.configurationVersion}</th><th>{t.status}</th><th>{t.configurationCurrency}</th><th>{t.configurationAmount}</th><th>{t.configurationTax}</th></tr></thead>
                    <tbody>
                      {state.offers.map(row => (
                        <tr key={row.offerId + '@' + row.version}>
                          <td>{row.label}<div className="muted"><code>{row.offerId}</code></div></td>
                          <td>{row.version}</td>
                          <td><Badge tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.status}</Badge></td>
                          <td>{row.isExplicitlyFree ? t.configurationFree : row.currency}</td>
                          <td>{row.isExplicitlyFree ? '—' : money(row.amountMinor, row.currency, lang)}</td>
                          <td><Badge tone={row.taxPolicy === 'CONFIGURED' ? 'success' : 'warning'}>{row.taxPolicy === 'CONFIGURED' ? t.configurationTaxConfigured : t.configurationTaxRequired}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                )}
                <p className="muted">{t.configurationTaxHint}</p>
              </Card>

              <Card>
                <h2>{t.configurationBudgets}</h2>
                {state.budgetPolicies.length === 0 ? <Empty>{t.configurationBudgetsEmpty}</Empty> : (
                  <div className="table-wrap"><table>
                    <thead><tr><th>{t.configurationPolicy}</th><th>{t.configurationVersion}</th><th>{t.status}</th><th>{t.configurationCurrency}</th><th>{t.configurationMaxMoney}</th><th>{t.configurationProviders}</th></tr></thead>
                    <tbody>
                      {state.budgetPolicies.map(row => (
                        <tr key={row.policyId + '@' + row.version}><td><code>{row.policyId}</code></td><td>{row.version}</td><td><Badge tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.status}</Badge></td><td>{row.currency}</td><td>{money(row.maxMoneyMinor, row.currency, lang)}</td><td>{row.providers.join(', ')}</td></tr>
                      ))}
                    </tbody>
                  </table></div>
                )}
              </Card>
            </>
          ) : null}

          {requested && canManage ? <ConfigurationForm lang={lang} workspaceId={requested} idempotencyKey={suggestedKey} /> : null}
          {requested && !canManage ? <Notice tone="warning" title={t.configurationNeedsAdminTitle}>{t.configurationNeedsAdmin}</Notice> : null}
        </>
      ) : null}
    </Shell>
  );
}
