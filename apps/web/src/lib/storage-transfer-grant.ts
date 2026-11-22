import 'server-only';
import { session, ApiError } from './api';
import { mintStorageTransfer } from './storage-transfer';

/** Only call after the canonical API has authorized and minted the object grant. */
export async function storageTransferGrant(url: string, method: 'GET' | 'PUT' = 'GET'): Promise<string> {
  const current = await session();
  if (!current) throw new ApiError('SESSION_REQUIRED');
  try { return mintStorageTransfer(url, method, current.workspaceId, current.token, process.env); }
  catch { throw new ApiError('STORAGE_RELAY_NOT_CONFIGURED'); }
}
