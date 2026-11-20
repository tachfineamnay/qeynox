'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { idSchema } from '@qeynox/contracts';
import { api, ApiError, sessionSchema } from './api';
import { invitationInboxSchema, invitationViewSchema } from './workspaces';

export interface WorkspaceActionState { code: string; message?: string }
const fail = (error: unknown): WorkspaceActionState => ({ code: error instanceof ApiError ? error.code : 'UNAVAILABLE' });

/** Explicit workspace switch: the presented session is revoked and a fresh one is issued. */
export async function switchWorkspaceAction(workspaceId: string): Promise<WorkspaceActionState> {
  try {
    const result = sessionSchema.parse(await api('/v1/auth/switch-workspace', 'POST', { workspaceId: idSchema.parse(workspaceId) }));
    (await cookies()).set('qx-session', JSON.stringify(result), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires: new Date(result.expiresAt) });
    return { code: 'OK' };
  } catch (error) { return fail(error); }
}

/** Create a workspace and open it as the active context. */
export async function createWorkspaceAction(input: { name: string; lang: string }): Promise<never> {
  let destination: string;
  try {
    const parsed = z.object({ name: z.string().trim().min(2).max(120), lang: z.string().min(2).max(12) }).parse(input);
    const created = z.object({ workspaceId: z.string(), name: z.string() })
      .parse(await api('/v1/workspaces', 'POST', { name: parsed.name }));
    const switched = sessionSchema.parse(await api('/v1/auth/switch-workspace', 'POST', { workspaceId: created.workspaceId }));
    (await cookies()).set('qx-session', JSON.stringify(switched), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires: new Date(switched.expiresAt) });
    destination = `/${parsed.lang}/workspaces?created=1`;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'UNAVAILABLE';
    redirect(`/${input.lang}/workspaces?create=${encodeURIComponent(code)}`);
  }
  redirect(destination);
}

export async function inviteMemberAction(input: { email: string; role: 'OWNER' | 'ADMIN' | 'MEMBER'; reason: string }): Promise<WorkspaceActionState & { invitation?: z.infer<typeof invitationViewSchema> }> {
  try {
    const parsed = z.object({
      email: z.email().max(320),
      role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
      reason: z.string().trim().min(10).max(500),
    }).strict().parse(input);
    const invitation = invitationViewSchema.parse(await api('/v1/workspaces/current/invitations', 'POST', parsed));
    return { code: 'OK', invitation };
  } catch (error) { return fail(error); }
}

export async function changeMemberRoleAction(input: { membershipId: string; role: 'OWNER' | 'ADMIN' | 'MEMBER'; reason: string }): Promise<WorkspaceActionState> {
  try {
    const parsed = z.object({ role: z.enum(['OWNER', 'ADMIN', 'MEMBER']), reason: z.string().trim().min(10).max(500) }).strict()
      .parse({ role: input.role, reason: input.reason });
    await api('/v1/workspaces/current/members/' + idSchema.parse(input.membershipId) + '/role', 'POST', parsed);
    return { code: 'OK' };
  } catch (error) { return fail(error); }
}

export async function revokeMemberAction(input: { membershipId: string; reason: string }): Promise<WorkspaceActionState> {
  try {
    const parsed = z.object({ reason: z.string().trim().min(10).max(500) }).strict().parse({ reason: input.reason });
    await api('/v1/workspaces/current/members/' + idSchema.parse(input.membershipId) + '/revoke', 'POST', parsed);
    return { code: 'OK' };
  } catch (error) { return fail(error); }
}

export async function acceptInvitationAction(membershipId: string): Promise<WorkspaceActionState> {
  try {
    await api('/v1/invitations/' + idSchema.parse(membershipId) + '/accept', 'POST', {});
    return { code: 'OK' };
  } catch (error) { return fail(error); }
}

export async function declineInvitationAction(membershipId: string): Promise<WorkspaceActionState> {
  try {
    await api('/v1/invitations/' + idSchema.parse(membershipId) + '/decline', 'POST', {});
    return { code: 'OK' };
  } catch (error) { return fail(error); }
}
