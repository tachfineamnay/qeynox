import Link from 'next/link';
import type { ReactNode } from 'react';
import { requirePlatformMe, tryApi } from '../../../lib/api';
import { copy, locale } from '../../../lib/copy';
import { can, READ_ORGANIZATIONS } from '../../../lib/permissions';
import { Card, Empty, Notice, PageHeader, PermissionDenied, Shell } from '../../../components/shell';
import type { OrganizationPageView } from '../../../lib/types';

function first(value: string | string[] | undefined): string { return typeof value === 'string' ? value : ''; }

export default async function OrganizationsPage({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lang = locale((await params).lang);
  const query = await searchParams;
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const search = first(query.query).trim();
  const cursor = first(query.cursor);
  const allowed = can(me.permissions, READ_ORGANIZATIONS);
  const paramsString = new URLSearchParams();
  if (search.length) paramsString.set('query', search);
  paramsString.set('limit', '20');
  if (cursor.length) paramsString.set('cursor', cursor);
  const result = allowed ? await tryApi<OrganizationPageView>('/v1/platform/organizations?' + paramsString.toString()) : null;
  let content: ReactNode;
  if (!allowed) content = <PermissionDenied lang={lang} />;
  else if (!result || !result.ok) content = <Notice tone="warning" title={t.apiUnavailable}>{t.apiCode + ': ' + (result && !result.ok ? result.code : 'UNAVAILABLE')}</Notice>;
  else if (result.value.items.length === 0) content = <Card><Empty>{t.noResults}</Empty></Card>;
  else {
    const nextParams = new URLSearchParams(paramsString);
    if (result.value.nextCursor) nextParams.set('cursor', result.value.nextCursor);
    content = (
      <Card>
        <div className="table-wrap"><table>
          <thead><tr><th>{t.workspace}</th><th>{t.active}</th><th>{t.owners}</th><th>{t.invitedCount}</th><th>{t.createdAt}</th><th>{t.open}</th></tr></thead>
          <tbody>
            {result.value.items.map(organization => (
              <tr key={organization.workspaceId}>
                <td>{organization.name}</td>
                <td>{organization.activeMembers}</td>
                <td>{organization.owners}</td>
                <td>{organization.invited}</td>
                <td>{new Date(organization.createdAt).toLocaleDateString(lang)}</td>
                <td><Link href={'/' + lang + '/organizations/' + encodeURIComponent(organization.workspaceId)}>{t.open}</Link></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <p className="pager">
          {result.value.nextCursor ? <Link className="button secondary" href={'/' + lang + '/organizations?' + nextParams.toString()}>{t.next}</Link> : null}
          {(search.length || cursor.length) ? <Link href={'/' + lang + '/organizations'}>{t.all}</Link> : null}
        </p>
      </Card>
    );
  }
  return (
    <Shell lang={lang} path="/organizations" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <PageHeader title={t.organizationsTitle} intro={t.organizationsIntro} />
      {allowed ? (
        <form className="card form" method="get" action={'/admin/' + lang + '/organizations'}>
          <div className="row-actions">
            <label className="field" style={{ flex: 2 }}><span>{t.search}</span><input name="query" defaultValue={search} /></label>
            <button className="button" type="submit">{t.filter}</button>
          </div>
        </form>
      ) : null}
      {content}
    </Shell>
  );
}
