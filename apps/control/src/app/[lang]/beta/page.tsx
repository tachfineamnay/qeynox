import { betaOperationsCopy } from '../../../lib/beta-operations-copy';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { requirePlatformMe, tryApi } from '../../../lib/api';
import { revokeBetaAction } from '../../../lib/actions';
import { copy, locale } from '../../../lib/copy';
import { can, MANAGE_BETA, READ_BETA } from '../../../lib/permissions';
import { BetaGrantForm } from '../../../components/beta-grant-form';
import { ApiErrorNotice, Badge, Card, Empty, OutcomeNotice, PageHeader, PermissionDenied, Shell } from '../../../components/shell';
import type { BetaGrantPageView, BetaGrantStatus } from '../../../lib/types';
import { betaTone, money } from '../../../lib/beta-format';

function first(value: string | string[] | undefined): string { return typeof value === 'string' ? value : ''; }
const statuses: readonly BetaGrantStatus[] = ['INVITED', 'ACTIVE', 'EXPIRED', 'REVOKED'];

/** MISSION A21.02 — invite-only beta grants (reads: ADMINISTRATION/SUPPORT; grant/revoke: ADMINISTRATION). */
export default async function BetaAccessPage({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lang = locale((await params).lang);
  const query = await searchParams;
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const allowed = can(me.permissions, READ_BETA);
  const canManage = can(me.permissions, MANAGE_BETA);
  const statusFilter = statuses.includes(first(query.status) as BetaGrantStatus) ? first(query.status) : '';
  const workspaceFilter = /^[A-Za-z0-9_-]{4,120}$/.test(first(query.workspaceId)) ? first(query.workspaceId) : '';
  const search = new URLSearchParams();
  if (statusFilter) search.set('status', statusFilter);
  if (workspaceFilter) search.set('workspaceId', workspaceFilter);
  search.set('limit', '100');
  const result = allowed ? await tryApi<BetaGrantPageView>('/v1/platform/beta-grants?' + search.toString()) : null;
  const done = typeof query.done === 'string' ? query.done : undefined;
  const error = typeof query.error === 'string' ? query.error : undefined;

  let content: ReactNode = null;
  if (!allowed) content = <PermissionDenied lang={lang} />;
  else if (!result || !result.ok) content = <ApiErrorNotice lang={lang} code={result && !result.ok ? result.code : 'UNAVAILABLE'} />;
  else if (result.value.items.length === 0) content = <Card><Empty>{t.betaNone}</Empty></Card>;
  else content = (
    <Card>
      <div className="table-wrap"><table>
        <thead><tr><th>{t.workspace}</th><th>{t.betaStatus}</th><th>{t.betaMissions}</th><th>{t.betaSpend}</th><th>{t.expiresAt}</th><th>{canManage ? t.action : t.open}</th></tr></thead>
        <tbody>
          {result.value.items.map(grant => (
            <tr key={grant.grantId}>
              <td><Link href={'/' + lang + '/beta/' + encodeURIComponent(grant.grantId)}>{grant.workspaceName ?? grant.workspaceId}</Link><br /><span className="muted">{grant.workspaceId}</span></td>
              <td><Badge tone={betaTone(grant.status)}>{grant.status}</Badge></td>
              <td>{grant.missionsUsed + ' / ' + grant.missionQuota}<br /><span className="muted">{t.betaConcurrentLimit + ': ' + grant.concurrentLimit}</span></td>
              <td>{money(grant.spentMinor, grant.currency, lang) + ' ' + t.betaSpent}<br /><span className="muted">{money(grant.reservedMinor, grant.currency, lang) + ' ' + t.betaReserved + ' · ' + money(grant.maxProviderSpendMinor, grant.currency, lang)}</span></td>
              <td>{new Date(grant.expiresAt).toLocaleString(lang)}</td>
              <td>
                {canManage && grant.status !== 'REVOKED' ? (
                  <form className="inline-form" action={revokeBetaAction}>
                    <input type="hidden" name="lang" value={lang} />
                    <input type="hidden" name="grantId" value={grant.grantId} />
                    <label className="field"><span>{t.justification}</span><input name="reason" required minLength={10} maxLength={500} /></label>
                    <button className="button danger" type="submit">{t.betaRevoke}</button>
                  </form>
                ) : <Link href={'/' + lang + '/beta/' + encodeURIComponent(grant.grantId)}>{t.open}</Link>}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <p className="muted">{t.betaRevokeHint}</p>
    </Card>
  );

  return (
    <Shell lang={lang} path="/beta" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <PageHeader title={t.betaTitle} intro={t.betaIntro} actions={<Link className="button secondary" href={'/'+lang+'/beta/invitations'}>{betaOperationsCopy[lang].invitations}</Link>} />
      <OutcomeNotice lang={lang} done={done} error={error} />
      {allowed ? (
        <form className="card form" method="get" action={'/admin/' + lang + '/beta'}>
          <div className="row-actions">
            <label className="field"><span>{t.betaStatus}</span>
              <select name="status" defaultValue={statusFilter}>
                <option value="">{t.all}</option>
                {statuses.map(status => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
            <label className="field" style={{ flex: 2 }}><span>{t.betaWorkspaceId}</span><input name="workspaceId" defaultValue={workspaceFilter} /></label>
            <button className="button" type="submit">{t.filter}</button>
          </div>
        </form>
      ) : null}
      {allowed && canManage ? <BetaGrantForm lang={lang} workspaceId={workspaceFilter || undefined} /> : null}
      {content}
    </Shell>
  );
}
