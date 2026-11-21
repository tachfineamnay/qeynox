import Link from 'next/link';
import { requirePlatformMe, tryApi } from '../../../../lib/api';
import { revokeBetaAction } from '../../../../lib/actions';
import { copy, locale } from '../../../../lib/copy';
import { can, MANAGE_BETA, READ_BETA } from '../../../../lib/permissions';
import { ApiErrorNotice, Badge, Card, Empty, OutcomeNotice, PageHeader, PermissionDenied, Shell } from '../../../../components/shell';
import type { BetaGrantDetailView } from '../../../../lib/types';
import { betaTone, money } from '../../../../lib/beta-format';

/** MISSION A21.02 — one beta grant with its usage and its append-only ledger. */
export default async function BetaGrantDetailPage({ params, searchParams }: { params: Promise<{ lang: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const resolved = await params;
  const lang = locale(resolved.lang);
  const query = await searchParams;
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const allowed = can(me.permissions, READ_BETA);
  const canManage = can(me.permissions, MANAGE_BETA);
  const result = allowed ? await tryApi<BetaGrantDetailView>('/v1/platform/beta-grants/' + encodeURIComponent(resolved.id)) : null;
  const done = typeof query.done === 'string' ? query.done : undefined;
  const error = typeof query.error === 'string' ? query.error : undefined;
  return (
    <Shell lang={lang} path="/beta" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <p className="pager"><Link href={'/' + lang + '/beta'}>{t.previous}</Link></p>
      {!allowed ? <PermissionDenied lang={lang} /> : null}
      <OutcomeNotice lang={lang} done={done} error={error} />
      {result && !result.ok ? <ApiErrorNotice lang={lang} code={result.code} /> : null}
      {result && result.ok ? (() => {
        const grant = result.value.grant;
        return (
          <>
            <PageHeader title={grant.workspaceName ?? grant.workspaceId} intro={t.betaDetail} actions={<Badge tone={betaTone(grant.status)}>{grant.status}</Badge>} />
            <div className="grid">
              <Card>
                <h2>{t.betaUsage}</h2>
                <dl className="kv">
                  <dt>{t.workspace}</dt><dd><Link href={'/' + lang + '/organizations/' + encodeURIComponent(grant.workspaceId)}>{grant.workspaceId}</Link></dd>
                  <dt>{t.betaStatus}</dt><dd>{grant.status + (grant.status !== grant.storedStatus ? ' (' + grant.storedStatus + ')' : '')}</dd>
                  <dt>{t.expiresAt}</dt><dd>{new Date(grant.expiresAt).toLocaleString(lang)}</dd>
                  {grant.invitationExpiresAt ? <><dt>{t.betaInvitationExpires}</dt><dd>{new Date(grant.invitationExpiresAt).toLocaleString(lang)}</dd></> : null}
                  <dt>{t.betaMissions}</dt><dd>{grant.missionsUsed + ' / ' + grant.missionQuota}</dd>
                  <dt>{t.betaConcurrentLimit}</dt><dd>{result.value.activeMissions + ' / ' + grant.concurrentLimit}</dd>
                  <dt>{t.betaSpend}</dt><dd>{money(grant.spentMinor, grant.currency, lang) + ' ' + t.betaSpent + ' · ' + money(grant.reservedMinor, grant.currency, lang) + ' ' + t.betaReserved + ' / ' + money(grant.maxProviderSpendMinor, grant.currency, lang)}</dd>
                  <dt>{t.betaGrantedBy}</dt><dd>{grant.grantedByEmail ?? grant.grantedBy}</dd>
                  <dt>{t.betaReason}</dt><dd>{grant.grantReason}</dd>
                  {grant.revokedAt ? <><dt>{t.betaRevokedBy}</dt><dd>{(grant.revokedBy ?? '—') + ' · ' + new Date(grant.revokedAt).toLocaleString(lang) + (grant.revokeReason ? ' · ' + grant.revokeReason : '')}</dd></> : null}
                </dl>
              </Card>
              {canManage && grant.status !== 'REVOKED' ? (
                <form className="card form" action={revokeBetaAction}>
                  <h2>{t.betaRevoke}</h2>
                  <p className="muted">{t.betaRevokeHint}</p>
                  <input type="hidden" name="lang" value={lang} />
                  <input type="hidden" name="grantId" value={grant.grantId} />
                  <input type="hidden" name="back" value="detail" />
                  <label className="field"><span>{t.justification}</span><textarea name="reason" required minLength={10} maxLength={500} rows={3} /></label>
                  <button className="button danger" type="submit">{t.betaRevoke}</button>
                </form>
              ) : null}
            </div>
            <Card>
              <h2>{t.betaEvents}</h2>
              {result.value.events.length === 0 ? <Empty>{t.noResults}</Empty> : (
                <div className="table-wrap"><table>
                  <thead><tr><th>{t.createdAt}</th><th>{t.action}</th><th>{t.actor}</th><th>{t.betaReason}</th></tr></thead>
                  <tbody>
                    {result.value.events.map(event => (
                      <tr key={event.eventId}>
                        <td>{new Date(event.occurredAt).toLocaleString(lang)}</td>
                        <td><Badge tone={event.kind.endsWith('DENIED') ? 'danger' : 'neutral'}>{event.kind}</Badge>{event.amountMinor !== null ? ' ' + money(event.amountMinor, grant.currency, lang) : ''}{event.operationId ? <><br /><span className="muted">{event.operationId}</span></> : null}</td>
                        <td>{event.actorUserId ?? '—'}</td>
                        <td>{event.reason ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </Card>
          </>
        );
      })() : null}
    </Shell>
  );
}
