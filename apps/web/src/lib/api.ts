import 'server-only';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { apiOrigin } from './api-origin';
export const sessionSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/), workspaceId: z.string().min(4), expiresAt: z.iso.datetime() });
export async function session() {
  const raw = (await cookies()).get('qx-session')?.value;
  try { const value = sessionSchema.parse(JSON.parse(raw ?? 'null')); return Date.parse(value.expiresAt) > Date.now() ? value : null; } catch { return null; }
}
export class ApiError extends Error { constructor(public code: string) { super(code); } }
export async function api(path: string, method = 'GET', body?: unknown, authenticated = true): Promise<unknown> {
  const base = process.env.QEYNOX_API_URL;
  if (!base) throw new ApiError('NOT_CONFIGURED');
  let url: URL;
  try { url = new URL(apiOrigin(base, process.env.QEYNOX_API_PRIVATE_ORIGIN)); }
  catch { throw new ApiError('NOT_CONFIGURED'); }
  const current = authenticated ? await session() : null;
  if (authenticated && !current) throw new ApiError('SESSION_REQUIRED');
  try {
    const response = await fetch(new URL(path, url), { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', ...(current ? { authorization: `Bearer ${current.token}`, 'x-qeynox-workspace': current.workspaceId } : {}) }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
    const value: unknown = await response.json();
    if (!response.ok) { const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(value); throw new ApiError(parsed.success ? parsed.data.error.code : 'UNAVAILABLE'); }
    return value;
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(method === 'GET' ? 'UNAVAILABLE' : 'UNKNOWN_OUTCOME'); }
}
export const operationSchema = z.object({ id: z.string(), title: z.string(), status: z.string(), lastActivityAt: z.iso.datetime() });
export const recentSchema = z.array(operationSchema.omit({ id: true }).extend({
  operationId: z.string(),
  attention: z.string().default('NONE'),
  stepCount: z.number().int().nonnegative().default(0),
  completedSteps: z.number().int().nonnegative().default(0),
  pendingApprovals: z.number().int().nonnegative().default(0),
  resultCount: z.number().int().nonnegative().default(0),
  evidenceCount: z.number().int().nonnegative().default(0),
}));
