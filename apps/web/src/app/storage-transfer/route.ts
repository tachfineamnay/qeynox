import { api, session } from '../../lib/api';
import { boundedTransferBody, openStorageTransfer } from '../../lib/storage-transfer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" };
async function relay(request: Request): Promise<Response> {
  const current = await session();
  if (!current) return new Response(null, { status: 401, headers });
  try {
    const publicOrigin = new URL(process.env.QEYNOX_PUBLIC_URL ?? '').origin;
    // A PUT is a same-origin browser operation, not a public S3 API or cross-site upload endpoint.
    if (request.method === 'PUT' && request.headers.get('origin') !== publicOrigin) return new Response(null, { status: 403, headers });
    const target = openStorageTransfer(new URL(request.url).searchParams.get('ticket') ?? '', request.method, current.workspaceId, current.token, process.env);
    const principal = await api('/v1/auth/me') as { workspaceId?: string };
    if (principal.workspaceId !== current.workspaceId) throw new Error('STORAGE_SCOPE_REVOKED');
    const body = request.method === 'PUT' ? await boundedTransferBody(request.body) : undefined;
    const upstream = await fetch(target, {
      method: request.method, body: body ? Buffer.from(body) : undefined,
      headers: request.method === 'PUT' ? { 'content-type': request.headers.get('content-type') ?? 'application/octet-stream' } : {},
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok) { await upstream.body?.cancel(); return new Response(null, { status: 502, headers }); }
    const bytes = request.method === 'GET' ? await boundedTransferBody(upstream.body) : null;
    if (request.method === 'PUT') await upstream.body?.cancel();
    return new Response(bytes ? Buffer.from(bytes) : null, {
      status: 200,
      headers: { ...headers, ...(bytes ? { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="qeynox-download"' } : {}) },
    });
  } catch { return new Response(null, { status: 403, headers }); }
}
export const GET = relay;
export const PUT = relay;
