import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DomainError } from '@qeynox/domain';
import { and, eq } from 'drizzle-orm';
import type { QeyNoxDatabase } from '@qeynox/persistence';
import { connectionCredentials } from '@qeynox/persistence';

/**
 * MISSION A14 — server-side connection credential vault.
 *
 * The vault is the only place provider token material exists in plaintext. It is deliberately
 * small: store / read / wipe, all fail-closed. Rules enforced here and nowhere else:
 *
 * - the AES-256 key comes from QEYNOX_CONNECTION_CREDENTIAL_KEY (base64, exactly 32 bytes). Without
 *   it, nothing can be stored or read — connecting is honestly unavailable;
 * - every value is sealed with AES-256-GCM; the auth tag is verified on every read. A wrong key or
 *   a tampered ciphertext fails, never produces "best effort" material;
 * - refs are opaque (cred_<uuid>) and workspace-scoped; a ref alone cannot cross tenants because
 *   resolution requires the caller's workspaceId;
 * - wiped credentials are hard-deleted; the row does not linger as an encrypted tombstone either;
 * - nothing here writes a log, an audit detail, an error message or a prompt fragment.
 */

export interface ConnectionMaterial {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly tokenType: string;
  /** ISO-8601 expiry of the access token, or null for non-expiring provider tokens. */
  readonly expiresAt: string | null;
  /** ISO-8601 expiry of the refresh token, or null when the provider does not publish one. */
  readonly refreshExpiresAt: string | null;
}

const IV_BYTES = 12;
const KEY_BYTES = 32;

function decodeKey(raw: string | undefined): Buffer {
  const value = (raw ?? '').trim();
  if (!value) throw new DomainError('NOT_CONFIGURED', 'Connection credential key is not configured (QEYNOX_CONNECTION_CREDENTIAL_KEY)');
  let key: Buffer;
  try { key = Buffer.from(value, 'base64'); } catch { throw new DomainError('NOT_CONFIGURED', 'Connection credential key is not valid base64'); }
  if (key.length !== KEY_BYTES) throw new DomainError('NOT_CONFIGURED', 'Connection credential key must decode to exactly 32 bytes');
  return key;
}

export class ConnectionCredentialVault {
  constructor(private readonly db: QeyNoxDatabase, private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** True when the deployment can store credentials at all; callers use it for honest availability. */
  configured(): boolean {
    try { decodeKey(this.env.QEYNOX_CONNECTION_CREDENTIAL_KEY); return true; } catch { return false; }
  }

  /** Stores material under a fresh opaque ref. Returns the ref; the material never returns. */
  async store(workspaceId: string, provider: string, material: ConnectionMaterial): Promise<string> {
    const key = decodeKey(this.env.QEYNOX_CONNECTION_CREDENTIAL_KEY);
    const ref = 'cred_' + randomBytes(16).toString('hex');
    const plaintext = Buffer.from(JSON.stringify({
      accessToken: material.accessToken,
      refreshToken: material.refreshToken,
      tokenType: material.tokenType,
      expiresAt: material.expiresAt,
      refreshExpiresAt: material.refreshExpiresAt,
    }), 'utf8');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    plaintext.fill(0);
    await this.db.insert(connectionCredentials).values({
      credentialRef: ref, workspaceId, provider, iv, authTag, ciphertext,
      createdAt: new Date(), updatedAt: new Date(),
    });
    return ref;
  }

  /**
   * Reads and decrypts material. The caller must be able to name the workspace — a ref from one
   * tenant cannot be used in another. Plaintext is returned only to the server-side caller
   * (token refresh, revocation, reviewed adapters via the resolver) and is never serialized
   * anywhere else.
   */
  async read(credentialRef: string, workspaceId: string): Promise<ConnectionMaterial> {
    if (!/^cred_[0-9a-f]{32}$/.test(credentialRef)) throw new DomainError('INVALID_INPUT', 'Malformed credential reference');
    const key = decodeKey(this.env.QEYNOX_CONNECTION_CREDENTIAL_KEY);
    const [row] = await this.db.select().from(connectionCredentials).where(eq(connectionCredentials.credentialRef, credentialRef)).limit(1);
    if (!row || row.workspaceId !== workspaceId) {
      // Same error either way: possession of a ref must not confirm existence across workspaces.
      throw new DomainError('NOT_CONFIGURED', 'Credential reference is not available');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
      decipher.setAuthTag(row.authTag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      const material = JSON.parse(plaintext.toString('utf8')) as ConnectionMaterial;
      plaintext.fill(0);
      if (typeof material.accessToken !== 'string' || !material.accessToken) throw new Error('missing access token');
      return {
        accessToken: material.accessToken,
        refreshToken: typeof material.refreshToken === 'string' ? material.refreshToken : null,
        tokenType: typeof material.tokenType === 'string' && material.tokenType ? material.tokenType : 'Bearer',
        expiresAt: typeof material.expiresAt === 'string' ? material.expiresAt : null,
        refreshExpiresAt: typeof material.refreshExpiresAt === 'string' ? material.refreshExpiresAt : null,
      };
    } catch (error: unknown) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('NOT_CONFIGURED', 'Stored connection credential cannot be read (key mismatch or corruption)');
    }
  }

  /** Hard-deletes the ciphertext (scoped to the workspace that holds the connection). */
  async wipe(credentialRef: string, workspaceId: string): Promise<void> {
    if (!/^cred_[0-9a-f]{32}$/.test(credentialRef)) return;
    await this.db.delete(connectionCredentials).where(and(eq(connectionCredentials.credentialRef, credentialRef), eq(connectionCredentials.workspaceId, workspaceId)));
  }
}
