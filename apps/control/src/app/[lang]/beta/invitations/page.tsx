import Link from 'next/link';
import { z } from 'zod';
import { requirePlatformMe } from '../../../../lib/api';
import { tryParsed } from '../../../../lib/operations';
import { copy, locale } from '../../../../lib/copy';
import { betaOperationsCopy } from '../../../../lib/beta-operations-copy';
import { can, READ_BETA, MANAGE_BETA } from '../../../../lib/permissions';
import { ApiErrorNotice, Badge, Card, Empty, PageHeader, PermissionDenied, Shell } from '../../../../components/shell';
import { RegistrationInvitationForm, RevokeRegistrationForm } from '../../../../components/beta-operations-forms';

const invitationsSchema = z.object({ items: z.array(z.object({ invitationId: z.string(), email: z.string(), status: z.enum(['PENDING','REDEEMED','EXPIRED','REVOKED']), expiresAt: z.string(), betaExpiresAt: z.string(), missionQuota: z.number(), concurrentLimit: z.number(), maxProviderSpendMinor: z.number(), currency: z.string(), redeemedUserId: z.string().nullable(), redeemedWorkspaceId: z.string().nullable(), betaGrantId: z.string().nullable() })), limit: z.number() });
export default async function InvitationsPage({ params, searchParams }: { params: Promise<{lang:string}>; searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  const lang=locale((await params).lang), t=copy[lang], b=betaOperationsCopy[lang];
  const me=await requirePlatformMe(lang), allowed=can(me.permissions,READ_BETA);
  const query=await searchParams;
  const email=typeof query.email==='string'?query.email:'';
  const status=typeof query.status==='string'&&['PENDING','REDEEMED','EXPIRED','REVOKED'].includes(query.status)?query.status:'';
  const filters=new URLSearchParams({limit:'100'});if(email)filters.set('email',email);if(status)filters.set('status',status);
  const result=allowed?await tryParsed('/v1/platform/registration-invitations?'+filters,invitationsSchema):null;
  return <Shell lang={lang} path="/beta/invitations" permissions={me.permissions} userId={me.userId} sessionExpiresAt={me.sessionExpiresAt}>
    <PageHeader title={b.invitations} intro={b.invitationIntro} actions={<Link href={'/'+lang+'/beta'}>{t.navBeta}</Link>} />
    {!allowed?<PermissionDenied lang={lang}/>:<>
      <form className="card form" method="get" action={'/admin/'+lang+'/beta/invitations'}><label className="field"><span>{t.email}</span><input name="email" type="email" defaultValue={email}/></label><label className="field"><span>{t.status}</span><select name="status" defaultValue={status}><option value="">{t.all}</option>{['PENDING','REDEEMED','EXPIRED','REVOKED'].map(value=><option key={value}>{value}</option>)}</select></label><button className="button">{t.filter}</button></form>
      {can(me.permissions,MANAGE_BETA)?<RegistrationInvitationForm lang={lang}/>:null}
      {result&&!result.ok?<ApiErrorNotice lang={lang} code={result.code}/>:null}
      {result?.ok?<Card>{!result.value.items.length?<Empty>{t.noResults}</Empty>:<div className="table-wrap"><table><thead><tr><th>{b.tester}</th><th>{t.status}</th><th>{b.quotas}</th><th>{b.workspace}</th><th>{t.action}</th></tr></thead><tbody>{result.value.items.map(item=><tr key={item.invitationId}>
        <td>{item.redeemedUserId?<Link href={'/'+lang+'/users/'+encodeURIComponent(item.redeemedUserId)}>{item.email}</Link>:item.email}<br/><code>{item.invitationId}</code></td>
        <td><Badge>{item.status}</Badge><br/>{new Date(item.expiresAt).toLocaleString(lang)}<br/>{b.expires}: {new Date(item.betaExpiresAt).toLocaleString(lang)}</td>
        <td>{item.missionQuota} / {item.concurrentLimit}<br/>{item.maxProviderSpendMinor.toLocaleString(lang)} {item.currency} ({t.betaSpendCap})</td>
        <td>{item.redeemedWorkspaceId?<Link href={'/'+lang+'/organizations/'+encodeURIComponent(item.redeemedWorkspaceId)}>{item.redeemedWorkspaceId}</Link>:'—'}{item.betaGrantId?<p><Link href={'/'+lang+'/beta/'+encodeURIComponent(item.betaGrantId)}>{b.grant}</Link></p>:null}</td>
        <td>{can(me.permissions,MANAGE_BETA)&&item.status==='PENDING'?<RevokeRegistrationForm lang={lang} id={item.invitationId}/>:null}</td>
      </tr>)}</tbody></table></div>}{result.value.items.length===result.value.limit?<p className="muted">{b.bounded}</p>:null}</Card>:null}
    </>}
  </Shell>;
}
