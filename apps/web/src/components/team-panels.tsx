'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Feedback } from './ui';
import { copy, type Locale } from '../lib/copy';
import { settingsCopy } from '../lib/settings-copy';
import { acceptInvitationAction, changeMemberRoleAction, createWorkspaceAction, declineInvitationAction, inviteMemberAction, revokeMemberAction, switchWorkspaceAction } from '../lib/workspace-actions';
import type { InvitationInboxItem, InvitationView, MemberView, WorkspaceSummary } from '../lib/workspaces';

const fmtDate = (lang: Locale, iso: string | null) =>
  iso ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso)) : '—';

export function Switcher({ lang, workspaces, currentId }: { lang: Locale; workspaces: WorkspaceSummary[]; currentId: string }) {
  const t = settingsCopy(lang);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [code, setCode] = useState('');
  return (
    <ul className="qx-connection-grid">
      {workspaces.map(w => {
        const active = w.workspaceId === currentId;
        return (
          <li key={w.workspaceId} className="qx-connection-card">
            <div className="qx-connection-head">
              <h2 style={{ fontSize: 17 }}>{w.name}</h2>
              {active ? <span className="badge info">{t.currentSpace}</span> : null}
            </div>
            <p className="muted">{t.myRole}: {w.role}</p>
            {!active && (
              <button type="button" className="ghost" disabled={pending} onClick={() => start(async () => {
                const result = await switchWorkspaceAction(w.workspaceId);
                setCode(result.code);
                if (result.code === 'OK') router.refresh();
              })}>{t.switchTo}</button>
            )}
          </li>
        );
      })}
      {code && code !== 'OK' && <Feedback error title={t.failed} />}
    </ul>
  );
}

export function CreateWorkspace({ lang }: { lang: Locale }) {
  const t = settingsCopy(lang); const [pending, start] = useTransition();
  return (
    <form onSubmit={event => {
      event.preventDefault();
      const name = String(new FormData(event.currentTarget).get('name') ?? '');
      start(async () => { await createWorkspaceAction({ name, lang }); });
    }} className="login-form">
      <label htmlFor="workspace-name">{t.workspaceName}</label>
      <input id="workspace-name" name="name" type="text" required minLength={2} maxLength={120} autoComplete="organization" disabled={pending} />
      <button disabled={pending}>{pending ? copy[lang].pending : t.create}</button>
    </form>
  );
}

export function InvitePanel({ lang }: { lang: Locale }) {
  const t = settingsCopy(lang);
  const [pending, start] = useTransition();
  const [invitation, setInvitation] = useState<InvitationView | null>(null);
  const [code, setCode] = useState('');
  return (
    <div>
      <p className="muted">{t.inviteNote}</p>
      {invitation ? (
        <Feedback title={t.invitedOnce}>
          <p><code style={{ overflowWrap: 'anywhere' }}>{invitation.invitationToken}</code></p>
          <p><small>{invitation.email} · {invitation.role} · {t.invited} {fmtDate(lang, invitation.invitationExpiresAt)}</small></p>
        </Feedback>
      ) : null}
      <form onSubmit={event => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        start(async () => {
          const result = await inviteMemberAction({ email: String(data.get('email') ?? ''), role: String(data.get('role') ?? 'MEMBER') as 'OWNER' | 'ADMIN' | 'MEMBER', reason: String(data.get('reason') ?? '') });
          setCode(result.code);
          setInvitation(result.invitation ?? null);
          if (result.invitation) form.reset();
        });
      }} className="login-form">
        <label htmlFor="invite-email">{t.inviteEmail}</label>
        <input id="invite-email" name="email" type="email" required maxLength={320} autoComplete="email" />
        <label htmlFor="invite-role">{t.inviteRole}</label>
        <select id="invite-role" name="role" defaultValue="MEMBER">
          <option value="MEMBER">{t.roleMember}</option>
          <option value="ADMIN">{t.roleAdmin}</option>
          <option value="OWNER">{t.roleOwner}</option>
        </select>
        <label htmlFor="invite-reason">{t.inviteReason}</label>
        <textarea id="invite-reason" name="reason" rows={2} minLength={10} maxLength={500} required />
        <button disabled={pending}>{t.invite}</button>
      </form>
      {code && code !== 'OK' && <Feedback error title={t.failed}>{code}</Feedback>}
    </div>
  );
}

export function MemberRow({ lang, member, canManage, isLastOwner, ownerCount }: { lang: Locale; member: MemberView; canManage: boolean; isLastOwner: boolean; ownerCount: number }) {
  const t = settingsCopy(lang);
  const [pending, start] = useTransition();
  const [code, setCode] = useState('');
  const roleLabel = member.role === 'OWNER' ? t.roleOwner : member.role === 'ADMIN' ? t.roleAdmin : t.roleMember;
  const statusLabel = member.status === 'ACTIVE' ? t.members : member.status === 'INVITED' ? t.pending : member.status === 'REVOKED' ? t.revoked : member.status;
  return (
    <li className="qx-connection-card">
      <div className="qx-connection-head">
        <div>
          <h3 style={{ fontSize: 16 }}>{member.email}{member.isSelf ? <span className="muted"> ({t.you})</span> : null}</h3>
          {member.disabled && <p className="feedback error" role="status">{t.disabled}</p>}
        </div>
        <span className="badge info">{roleLabel}</span>
      </div>
      <dl className="qx-connection-meta">
        <div><dt>{t.myRole}</dt><dd>{roleLabel}</dd></div>
        <div><dt>{t.joined}</dt><dd>{fmtDate(lang, member.joinedAt ?? member.invitedAt)}</dd></div>
        <div><dt>{t.members}</dt><dd>{statusLabel}</dd></div>
      </dl>
      {canManage ? (
        <form onSubmit={event => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const role = String(data.get('role') ?? 'MEMBER') as 'OWNER' | 'ADMIN' | 'MEMBER';
          const reason = String(data.get('reason') ?? '');
          start(async () => {
            const result = await changeMemberRoleAction({ membershipId: member.membershipId, role, reason });
            setCode(result.code);
            if (result.code === 'OK') window.location.reload();
          });
        }}>
          <label htmlFor={'role-' + member.membershipId}>{t.changeRole}</label>
          <select id={'role-' + member.membershipId} name="role" defaultValue={member.role}>
            <option value="MEMBER">{t.roleMember}</option>
            <option value="ADMIN">{t.roleAdmin}</option>
            <option value="OWNER">{t.roleOwner}</option>
          </select>
          <input name="reason" type="text" minLength={10} maxLength={500} placeholder={t.inviteReason} required aria-label={t.inviteReason} />
          <button type="submit" className="ghost" disabled={pending || isLastOwner} title={isLastOwner ? t.lastOwner : undefined}>{t.changeRoleButton}</button>
          <button type="button" className="ghost" disabled={pending || isLastOwner} title={isLastOwner ? t.lastOwner : undefined} onClick={() => {
            if (!window.confirm(t.revokeConfirm)) return;
            const reason = window.prompt(t.inviteReason, '') ?? '';
            if (reason.trim().length < 10) { setCode('INVALID_INPUT'); return; }
            start(async () => { const result = await revokeMemberAction({ membershipId: member.membershipId, reason: reason.trim() }); setCode(result.code); if (result.code === 'OK') window.location.reload(); });
          }}>{t.revokeMember}</button>
        </form>
      ) : null}
      {isLastOwner && ownerCount === 1 && <p className="muted">{t.lastOwner}</p>}
      {code === 'DENIED' && <Feedback error title={t.lastOwnerRefusal} />}
      {code && code !== 'OK' && code !== 'DENIED' && <Feedback error title={t.failed} />}
    </li>
  );
}

export function InvitationInbox({ lang, items }: { lang: Locale; items: InvitationInboxItem[] }) {
  const t = settingsCopy(lang);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [code, setCode] = useState('');
  if (items.length === 0) return null;
  return (
    <div>
      <h2>{t.invitationsForYou}</h2>
      <p className="muted">{t.invitationsNote}</p>
      <ul className="qx-connection-grid">
        {items.map(item => (
          <li key={item.membershipId} className="qx-connection-card">
            <div className="qx-connection-head">
              <h3 style={{ fontSize: 16 }}>{item.workspaceName}</h3>
              <span className="badge warning">{item.role}</span>
            </div>
            <div>
              <button type="button" disabled={pending} onClick={() => start(async () => { const r = await acceptInvitationAction(item.membershipId); setCode(r.code); if (r.code === 'OK') router.refresh(); })}>{t.accept}</button>
              <button type="button" className="ghost" disabled={pending} onClick={() => start(async () => { const r = await declineInvitationAction(item.membershipId); setCode(r.code); if (r.code === 'OK') router.refresh(); })}>{t.decline}</button>
            </div>
          </li>
        ))}
      </ul>
      {code && code !== 'OK' && <Feedback error title={t.failed} />}
    </div>
  );
}
