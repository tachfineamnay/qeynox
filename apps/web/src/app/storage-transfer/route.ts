import { api, session, ApiError } from '../../lib/api';
import { boundedTransferBody, openStorageTransfer, storageTransferHeaders, storageTransferAuthorization, StorageTransferError } from '../../lib/storage-transfer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" };
function failure(code: string, status: number): Response { return Response.json({ error: { code } }, { status, headers }); }
async function relay(request: Request): Promise<Response> {
  const current = await session();
  if (!current) return failure('SESSION_REQUIRED', 401);
  const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  try {
    const publicOrigin = new URL(process.env.QEYNOX_PUBLIC_URL ?? '').origin;
    if (request.method === 'PUT' && request.headers.get('origin') !== publicOrigin) return failure('STORAGE_TRANSFER_DENIED', 403);
    const target = openStorageTransfer(new URL(request.url).searchParams.get('ticket') ?? '', request.method, current.workspaceId, current.token, process.env);
    const principal = await api('/v1/auth/me') as { workspaceId?: string };
    if (principal.workspaceId !== current.workspaceId) return failure('STORAGE_TRANSFER_DENIED', 403);
    const authorization = storageTransferAuthorization(target, request.method);
    const resource = await api(authorization.path) as { state?: string; expired?: boolean };
    if (authorization.pendingUpload && (resource.state !== 'PENDING_UPLOAD' || resource.expired !== false)) return failure('STORAGE_TRANSFER_DENIED', 403);
    const body = request.method === 'PUT' ? await boundedTransferBody(request.body, deadline) : undefined;
    const verifiedTarget = openStorageTransfer(new URL(request.url).searchParams.get('ticket') ?? '', request.method, current.workspaceId, current.token, process.env);
    const upstream = await fetch(verifiedTarget, {
      method: request.method, body: body ? Buffer.from(body) : undefined,
      headers: request.method === 'PUT' ? storageTransferHeaders(target, request.headers.get('content-type') ?? 'application/octet-stream') : {},
      redirect: 'error', cache: 'no-store', signal: deadline,
    }).catch(() => { throw new StorageTransferError('STORAGE_TRANSFER_UNAVAILABLE', 502); });
    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => undefined);
      // Never return an S3 XML error, signed URL, bucket name or credential to the browser.
      if (upstream.status === 412) return failure('UPLOAD_ALREADY_EXISTS', 409);
      if (upstream.status === 404) return failure('STORAGE_OBJECT_UNAVAILABLE', 404);
      return failure('STORAGE_TRANSFER_UNAVAILABLE', 502);
    }
    const bytes = request.method === 'GET' ? await boundedTransferBody(upstream.body, deadline) : null;
    if (request.method === 'PUT') void upstream.body?.cancel().catch(() => undefined);
    return new Response(bytes ? Buffer.from(bytes) : null, {
      status: 200,
      headers: { ...headers, ...(bytes ? { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="qeynox-download"' } : {}) },
    });
  } catch (error) {
    if (deadline.aborted) return failure('STORAGE_TRANSFER_TIMEOUT', 504);
    if (error instanceof StorageTransferError) return failure(error.code, error.status);
    if (error instanceof ApiError) {
      if (error.code === 'SESSION_REQUIRED') return failure('SESSION_REQUIRED', 401);
      if (error.code === 'DENIED' || error.code === 'NOT_FOUND' || error.code === 'INVALID_STATE') return failure('STORAGE_TRANSFER_DENIED', 403);
      return failure('STORAGE_AUTH_UNAVAILABLE', 503);
    }
    return failure('STORAGE_TRANSFER_DENIED', 403);
  }
}
export const GET = relay;
export const PUT = relay;
