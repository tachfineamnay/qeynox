import Link from 'next/link';
import type { ReactNode } from 'react';
import { requirePlatformMe, tryApi } from '../../../lib/api';
import { copy, locale } from '../../../lib/copy';
import { can, READ_USERS } from '../../../lib/permissions';
import { ApiErrorNotice, Badge, Card, Empty, Notice, PageHeader, PermissionDenied, Shell } from '../../../components/shell';
import type { UserPageView } from '../../../lib/types';

function first(value: string | string[] | undefined): string { return typeof value === 'string' ? value : ''; }

export default async function UsersPage({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lang = locale((await params).lang);
  const query = await searchParams;
  const t = copy[lang];
  const me = await requirePlatformMe(lang);
  const search = first(query.query).trim();
  const status = first(query.status) === 'ACTIVE' || first(query.status) === 'SUSPENDED' ? first(query.status) : '';
  const cursor = first(query.cursor);
  const allowed = can(me.permissions, READ_USERS);
  const paramsString = new URLSearchParams();
  if (search.length) paramsString.set('query', search);
  if (status.length) paramsString.set('status', status);
  paramsString.set('limit', '20');
  if (cursor.length) paramsString.set('cursor', cursor);
  const result = allowed ? await tryApi<UserPageView>('/v1/platform/users?' + paramsString.toString()) : null;
  let content: ReactNode;
  if (!allowed) content = <PermissionDenied lang={lang} />;
  else if (!result || !result.ok) content = <ApiErrorNotice lang={lang} code={result && !result.ok ? result.code : 'UNAVAILABLE'} />;
  else if (result.value.items.length === 0) content = <Card><Empty>{t.noResults}</Empty></Card>;
  else {
    const nextParams = new URLSearchParams(paramsString);
    if (result.value.nextCursor) nextParams.set('cursor', result.value.nextCursor);
    content = (
      <Card>
        <div className="table-wrap"><table>
          <thead><tr><th>{t.emailLabel}</th><th>{t.status}</th><th>{t.createdAt}</th><th>{t.workspacesCount}</th><th>{t.open}</th></tr></thead>
          <tbody>
            {result.value.items.map(user => (
              <tr key={user.userId}>
                <td>{user.email}</td>
                <td><Badge tone={user.status === 'ACTIVE' ? 'success' : 'warning'}>{user.status === 'ACTIVE' ? t.active : t.suspended}</Badge></td>
                <td>{new Date(user.createdAt).toLocaleDateString(lang)}</td>
                <td>{user.workspaceCount}</td>
                <td><Link href={'/' + lang + '/users/' + encodeURIComponent(user.userId)}>{t.open}</Link></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <p className="pager">
          {result.value.nextCursor ? <Link className="button secondary" href={'/' + lang + '/users?' + nextParams.toString()}>{t.next}</Link> : null}
          {(search.length || status.length || cursor.length) ? <Link href={'/' + lang + '/users'}>{t.all}</Link> : null}
        </p>
      </Card>
    );
  }
  return (
    <Shell lang={lang} path="/users" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
      <PageHeader title={t.usersTitle} intro={t.usersIntro} />
      {allowed ? (
        <form className="card form" method="get" action={'/admin/' + lang + '/users'}>
          <div className="row-actions">
            <label className="field" style={{ flex: 2 }}><span>{t.search}</span><input name="query" defaultValue={search} /></label>
            <label className="field" style={{ flex: 1 }}><span>{t.status}</span>
              <select name="status" defaultValue={status}>
                <option value="">{t.all}</option>
                <option value="ACTIVE">{t.active}</option>
                <option value="SUSPENDED">{t.suspended}</option>
              </select>
            </label>
            <button className="button" type="submit">{t.filter}</button>
          </div>
        </form>
      ) : null}
      {content}
    </Shell>
  );
}