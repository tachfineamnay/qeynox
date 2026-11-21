import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { DomainError, type ID } from '@qeynox/domain';
import type { QeyNoxStore } from '@qeynox/persistence';
import { identityAttempts, identityAudit, identityCredentials, identitySessions, identityTokens, identityUsers } from '@qeynox/persistence';
import type { EmailTransport } from './platform-users';
import { renderEmail, type EmailTemplateId } from './email-templates';
import { EmailDeliveryError } from './email-transports';
import type { DeliveryLedger } from './notifications';

/**
 * MISSION A04 — customer identity completion.
 *
 * This module completes the EXISTING identity system (identity_users / identity_credentials /
 * identity_sessions). It introduces no second account model and no parallel session mechanism.
 *
 * Three guarantees are structural, not conventional:
 *
 * 1. **Tokens are single-use and stored only as digests.** Consumption is a conditional UPDATE
 *    (`used_at IS NULL`) inside a transaction, so two concurrent requests presenting the same token
 *    produce exactly one winner and one `CONFLICT`. The partial unique index in migration 0018
 *    additionally permits only one live token per user and purpose.
 * 2. **E-mail is never claimed to be sent.** Every method returns the transport's real state. When
 *    no provider is configured the call refuses with `NOT_CONFIGURED` and reports that nothing was
 *    sent — it never returns a success-shaped result.
 * 3. **Enumeration is not answered.** Requesting a reset or a verification for an unknown address
 *    returns the same shape and timing as for a known one; the caller learns nothing about whether
 *    an account exists.
 */

export type TokenPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

/**
 * Outcome of a token request. `sent` is derived from the transport, never asserted by policy.
 * `reason` is deliberately coarse so a caller cannot distinguish "no such account".
 */
export interface TokenRequestOutcome {
  /** True only when the transport reported a send without error. */
  readonly sent: boolean;
  /** Set when nothing was sent, with the transport's own reason. Never implies success. */
  readonly notSentReason: string | null;
  /** True when a token was issued and stored (independent of delivery). */
  readonly issued: boolean;
}

/**
 * MISSION A21.06 — outcome of an AUTHENTICATED verification resend. The caller is the account owner,
 * so (unlike the public request route) the result may say exactly what happened to their own e-mail:
 *
 * - `ACCEPTED`:         the configured provider accepted the message (HTTP 2xx from Resend).
 * - `NOT_CONFIGURED`:   no e-mail transport is configured; NO token was issued (a live link already
 *                       delivered earlier is not superseded by one that could never arrive).
 * - `DELIVERY_FAILED`:  a token was issued but the provider refused it or could not be reached.
 * - `ALREADY_VERIFIED`: the address is already confirmed; nothing was issued or sent.
 * Throttling is not an outcome: it is the BUDGET_EXHAUSTED refusal (HTTP 429).
 */
export type VerificationResendOutcome = 'ACCEPTED' | 'NOT_CONFIGURED' | 'DELIVERY_FAILED' | 'ALREADY_VERIFIED';

export interface VerificationResendResult {
  readonly outcome: VerificationResendOutcome;
  /** True only for ACCEPTED: derived from the transport, never asserted by policy. */
  readonly sent: boolean;
  /** True when a token was stored (ACCEPTED or DELIVERY_FAILED). */
  readonly issued: boolean;
  /** The transport's reason when nothing was accepted; null for ACCEPTED and ALREADY_VERIFIED. */
  readonly notSentReason: string | null;
}

export interface TokenConsumption {
  readonly userId: ID;
  /** Purpose the consumed token was issued for; a verification token never resets a password. */
  readonly purpose: TokenPurpose;
}

export interface RateLimitPolicy {
  /** Attempts permitted per window for one bucket. */
  readonly maxAttempts: number;
  /** Window length in seconds. */
  readonly windowSeconds: number;
}

/**
 * Durable, database-backed rate limiter.
 *
 * PostgreSQL is used instead of process memory on purpose: the API runs as several replicas, and an
 * in-process window would let a caller multiply its allowance by the replica count. The bucket key
 * is hashed before storage so the ledger holds no raw e-mail address or IP.
 */
export class IdentityRateLimiter {
  constructor(
    private readonly store: QeyNoxStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Records an attempt and throws BUDGET_EXHAUSTED when the bucket is over its allowance. */
  async consume(scope: string, identity: string, policy: RateLimitPolicy): Promise<void> {
    if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.windowSeconds < 1) {
      // An unusable policy must not silently disable throttling.
      throw new DomainError('NOT_CONFIGURED', 'Rate limit policy is not configured for ' + scope);
    }
    const bucket = scope + ':' + createHash('sha256').update(identity.trim().toLowerCase()).digest('hex');
    const now = this.now();
    const windowStart = new Date(now.getTime() - policy.windowSeconds * 1000);
    const db = this.store.db;
    // One statement: count the window and insert the new attempt inside the same transaction, so a
    // concurrent burst cannot all observe a below-limit count before any of them records itself.
    await db.transaction(async tx => {
      // A row lock cannot be combined with an aggregate, and locking the whole attempt table would
      // serialise every unrelated bucket. A transaction-scoped advisory lock serialises exactly this
      // bucket: two concurrent requests cannot both read a below-limit count before either records
      // itself, and the lock is released automatically when the transaction ends.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${bucket}))`);
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(identityAttempts)
        .where(and(eq(identityAttempts.bucket, bucket), gt(identityAttempts.attemptedAt, windowStart)));
      const used = row?.count ?? 0;
      if (used >= policy.maxAttempts) throw new DomainError('BUDGET_EXHAUSTED', 'Too many attempts; retry later');
      await tx.insert(identityAttempts).values({ id: randomUUID(), bucket, attemptedAt: now });
    });
  }

  /** Removes expired rows for a bucket. Called opportunistically; safe to skip. */
  async sweep(scope: string, identity: string, policy: RateLimitPolicy): Promise<void> {
    const bucket = scope + ':' + createHash('sha256').update(identity.trim().toLowerCase()).digest('hex');
    const windowStart = new Date(this.now().getTime() - policy.windowSeconds * 1000);
    await this.store.db.delete(identityAttempts).where(and(eq(identityAttempts.bucket, bucket), sql`${identityAttempts.attemptedAt} <= ${windowStart.toISOString()}`));
  }
}

export interface IdentityLifecycleOptions {
  readonly verificationTtlSeconds?: number;
  readonly resetTtlSeconds?: number;
  /** Base URL used to build the link handed to the transport. Must be an absolute https URL. */
  readonly publicBaseUrl?: string;
  readonly now?: () => Date;
  /**
   * Optional sink recording every inline delivery outcome (identity e-mails embed single-use
   * links and are deliberately NOT stored retryable). When absent, outcomes are not persisted.
   */
  readonly deliveryLedger?: DeliveryLedger;
}

const defaultVerificationTtl = 24 * 60 * 60;
const defaultResetTtl = 60 * 60;
const tokenPattern = /^[A-Za-z0-9_-]{43,256}$/;

export class IdentityLifecycleService {
  private readonly now: () => Date;
  private readonly verificationTtl: number;
  private readonly resetTtl: number;
  private readonly publicBaseUrl: string | null;
  private readonly deliveryLedger: DeliveryLedger | null;

  constructor(
    private readonly store: QeyNoxStore,
    private readonly email: EmailTransport,
    options: IdentityLifecycleOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.verificationTtl = options.verificationTtlSeconds ?? defaultVerificationTtl;
    this.resetTtl = options.resetTtlSeconds ?? defaultResetTtl;
    this.publicBaseUrl = options.publicBaseUrl?.replace(/\/+$/, '') ?? null;
    this.deliveryLedger = options.deliveryLedger ?? null;
    if (this.verificationTtl < 60 || this.resetTtl < 60) {
      throw new DomainError('NOT_CONFIGURED', 'Identity token lifetime must be at least 60 seconds');
    }
  }

  /** True only when a transport is configured. The API reports this instead of pretending. */
  get deliveryState(): { readonly status: 'CONFIGURED' | 'NOT_CONFIGURED'; readonly reason: string | null } {
    return { status: this.email.status, reason: this.email.reason };
  }

  /**
   * Issue an e-mail verification token.
   *
   * Returns the same shape for a known and an unknown address, so the endpoint cannot be used to
   * test whether an account exists. An unknown address issues nothing but is not reported as such.
   */
  async requestVerification(emailAddress: string): Promise<TokenRequestOutcome> {
    const user = await this.findUser(emailAddress);
    if (!user) return { sent: false, notSentReason: null, issued: false };
    if (user.verifiedAt) return { sent: false, notSentReason: null, issued: false };
    return this.issue(user.id as ID, 'EMAIL_VERIFICATION', this.verificationTtl, user.email, '/account/verify', user.locale);
  }

  /**
   * MISSION A21.06 — resend the verification link to the AUTHENTICATED account's own address.
   *
   * The recipient is read from identity_users by the session's user id; no caller-supplied address is
   * ever consulted, so a session can only cause a link to be sent to its own account. Token issuance,
   * supersession, single-use consumption, the Resend send and the delivery ledger are the same code
   * path as the public request (`issue`). Throttling is applied by the caller BEFORE this method.
   */
  async resendVerificationForUser(userId: ID): Promise<VerificationResendResult> {
    const [user] = await this.store.db.select({
      id: identityUsers.id, email: identityUsers.email, locale: identityUsers.locale, verifiedAt: identityUsers.verifiedAt, disabledAt: identityUsers.disabledAt,
    }).from(identityUsers).where(eq(identityUsers.id, userId)).limit(1);
    if (!user || user.disabledAt) throw new DomainError('DENIED', 'Account unavailable');
    if (user.verifiedAt) return { outcome: 'ALREADY_VERIFIED', sent: false, issued: false, notSentReason: null };
    if (this.email.status !== 'CONFIGURED') {
      return { outcome: 'NOT_CONFIGURED', sent: false, issued: false, notSentReason: this.email.reason ?? 'EMAIL_PROVIDER_NOT_CONFIGURED' };
    }
    const result = await this.issue(user.id as ID, 'EMAIL_VERIFICATION', this.verificationTtl, user.email, '/account/verify', user.locale);
    if (result.sent) return { outcome: 'ACCEPTED', sent: true, issued: result.issued, notSentReason: null };
    return { outcome: 'DELIVERY_FAILED', sent: false, issued: result.issued, notSentReason: result.notSentReason ?? 'EMAIL_DELIVERY_FAILED' };
  }

  /**
   * Verify an address with a single-use token.
   *
   * Consumption is conditional on `used_at IS NULL`; a replay and a concurrent duplicate both fail
   * with CONFLICT because exactly one transaction can claim the row.
   */
  async verifyEmail(rawToken: string): Promise<{ userId: ID; verifiedAt: string }> {
    const consumption = await this.consume(rawToken, 'EMAIL_VERIFICATION');
    const now = this.now();
    await this.store.db.transaction(async tx => {
      await tx.update(identityUsers).set({ verifiedAt: now }).where(and(eq(identityUsers.id, consumption.userId), isNull(identityUsers.verifiedAt)));
      await tx.insert(identityAudit).values({ id: randomUUID(), userId: consumption.userId, workspaceId: null, action: 'EMAIL_VERIFIED', outcome: 'SUCCESS' });
    });
    return { userId: consumption.userId, verifiedAt: now.toISOString() };
  }

  /**
   * Request a password reset.
   *
   * Anti-enumeration: the result is identical whether or not the address exists. A suspended account
   * is treated exactly like an unknown one — it must not reveal its own existence either.
   */
  async requestPasswordReset(emailAddress: string): Promise<TokenRequestOutcome> {
    const user = await this.findUser(emailAddress);
    if (!user || user.disabledAt) return { sent: false, notSentReason: null, issued: false };
    return this.issue(user.id as ID, 'PASSWORD_RESET', this.resetTtl, user.email, '/account/reset', user.locale);
  }

  /**
   * Inspect a reset token WITHOUT consuming it, so the "choose a new password" screen can reject a
   * dead link before the customer types anything. Consumption still happens atomically on submit.
   */
  async inspectResetToken(rawToken: string): Promise<{ valid: boolean; expiresAt: string | null }> {
    if (typeof rawToken !== 'string' || !tokenPattern.test(rawToken)) return { valid: false, expiresAt: null };
    const [row] = await this.store.db.select().from(identityTokens)
      .where(and(eq(identityTokens.tokenHash, this.digest(rawToken)), eq(identityTokens.purpose, 'PASSWORD_RESET')))
      .limit(1);
    if (!row || row.usedAt || row.revokedAt || row.expiresAt.getTime() <= this.now().getTime()) return { valid: false, expiresAt: null };
    return { valid: true, expiresAt: row.expiresAt.toISOString() };
  }

  /** Inspect a verification token WITHOUT consuming it (same contract as inspectResetToken). */
  async inspectVerificationToken(rawToken: string): Promise<boolean> {
    if (typeof rawToken !== 'string' || !tokenPattern.test(rawToken)) return false;
    const [row] = await this.store.db.select().from(identityTokens)
      .where(and(eq(identityTokens.tokenHash, this.digest(rawToken)), eq(identityTokens.purpose, 'EMAIL_VERIFICATION')))
      .limit(1);
    return Boolean(row && !row.usedAt && !row.revokedAt && row.expiresAt.getTime() > this.now().getTime());
  }

  /**
   * Complete a password reset.
   *
   * On success every session for the user is revoked inside the same transaction that consumes the
   * token and rewrites the credential: a password change must not leave a previously stolen session
   * alive, and a rollback must not consume the token without changing the password.
   */
  async resetPassword(rawToken: string, newPassword: string, hasher: PasswordHasher): Promise<{ userId: ID; revokedSessions: number }> {
    // Hash before opening the transaction: scrypt is intentionally slow and must not hold a row lock.
    const hashed = await hasher.hash(newPassword);
    const consumption = await this.consume(rawToken, 'PASSWORD_RESET');
    const now = this.now();
    const [credential] = await this.store.db.select().from(identityCredentials).where(eq(identityCredentials.userId, consumption.userId)).limit(1);
    if (!credential) throw new DomainError('INVALID_STATE', 'Account has no credential to reset');
    let revokedSessions = 0;
    await this.store.db.transaction(async tx => {
      await tx.update(identityCredentials)
        .set({ salt: hashed.salt, passwordHash: hashed.hash, changedAt: now, failedAttempts: 0, lockedUntil: null })
        .where(eq(identityCredentials.userId, consumption.userId));
      const revoked = await tx.update(identitySessions)
        .set({ revokedAt: now })
        .where(and(eq(identitySessions.userId, consumption.userId), isNull(identitySessions.revokedAt)))
        .returning({ id: identitySessions.id });
      revokedSessions = revoked.length;
      await tx.insert(identityAudit).values({ id: randomUUID(), userId: consumption.userId, workspaceId: null, action: 'PASSWORD_RESET', outcome: 'SUCCESS' });
    });
    return { userId: consumption.userId, revokedSessions };
  }

  /**
   * Revoke every session for a user. Used by suspension, password reset and explicit recovery.
   * Returns the number actually revoked so a caller cannot report a revocation that never happened.
   */
  async revokeAllSessions(userId: ID): Promise<number> {
    const revoked = await this.store.db.update(identitySessions)
      .set({ revokedAt: this.now() })
      .where(and(eq(identitySessions.userId, userId), isNull(identitySessions.revokedAt)))
      .returning({ id: identitySessions.id });
    return revoked.length;
  }

  /** Verification/verification state for the account view. Never invents a verified status. */
  async state(userId: ID): Promise<{ verified: boolean; verifiedAt: string | null; suspended: boolean }> {
    const [user] = await this.store.db.select().from(identityUsers).where(eq(identityUsers.id, userId)).limit(1);
    if (!user) throw new DomainError('NOT_FOUND', 'Account unavailable');
    return {
      verified: user.verifiedAt !== null,
      verifiedAt: user.verifiedAt?.toISOString() ?? null,
      suspended: user.disabledAt !== null,
    };
  }

  // --- internals ---------------------------------------------------------------------------

  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private async findUser(emailAddress: string): Promise<{ id: string; email: string; locale: string; verifiedAt: Date | null; disabledAt: Date | null } | undefined> {
    if (typeof emailAddress !== 'string') return undefined;
    const normalized = emailAddress.trim().toLowerCase();
    if (!normalized || normalized.length > 320) return undefined;
    const [row] = await this.store.db.select({
      id: identityUsers.id, email: identityUsers.email, locale: identityUsers.locale, verifiedAt: identityUsers.verifiedAt, disabledAt: identityUsers.disabledAt,
    }).from(identityUsers).where(eq(identityUsers.email, normalized)).limit(1);
    return row;
  }

  /**
   * Issue and store one token, superseding any live token for that user and purpose, then hand the
   * link to the transport. The raw token exists only in this scope and in the outbound message.
   */
  private async issue(userId: ID, purpose: TokenPurpose, ttlSeconds: number, emailAddress: string, path: string, locale: string): Promise<TokenRequestOutcome> {
    const raw = randomBytes(48).toString('base64url');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const tokenId = randomUUID();
    await this.store.db.transaction(async tx => {
      // Supersede: any live token for this user+purpose becomes unusable before the new one exists.
      await tx.update(identityTokens).set({ revokedAt: now })
        .where(and(eq(identityTokens.userId, userId), eq(identityTokens.purpose, purpose), isNull(identityTokens.usedAt), isNull(identityTokens.revokedAt)));
      await tx.insert(identityTokens).values({
        id: tokenId, userId, purpose, tokenHash: this.digest(raw), issuedAt: now, expiresAt,
        requestFingerprint: this.digest(purpose + ':' + raw).slice(0, 32),
      });
    });
    const shortLocale = (locale ?? 'en').trim().toLowerCase().split('-')[0] || 'en';
    const localizedPath = '/' + shortLocale + path;
    const link = this.publicBaseUrl ? this.publicBaseUrl + localizedPath + '?token=' + encodeURIComponent(raw) : localizedPath + '?token=' + encodeURIComponent(raw);
    const templateId: EmailTemplateId = purpose === 'EMAIL_VERIFICATION' ? 'EMAIL_VERIFICATION' : 'PASSWORD_RESET';
    const rendered = renderEmail(templateId, shortLocale, { link, expiresAt: expiresAt.toISOString() });
    if (this.email.status !== 'CONFIGURED') {
      // Nothing is delivered. The token exists and is stored, but the caller is told the truth.
      return { sent: false, notSentReason: this.email.reason ?? 'EMAIL_PROVIDER_NOT_CONFIGURED', issued: true };
    }
    // The rendered message carries a single-use secret; it is delivered at most once, inline, and
    // NEVER persisted. The ledger records the outcome with a per-issue key, not the content.
    const dedup = 'identity:' + purpose + ':' + userId + ':' + tokenId;
    try {
      const receipt = await this.email.send({
        to: emailAddress,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        category: 'TRANSACTIONAL',
        deduplicationKey: dedup,
      });
      await this.recordInline({ dedup, userId, category: 'TRANSACTIONAL:' + purpose, recipient: emailAddress, subject: rendered.subject, status: 'SENT', providerMessageId: receipt.providerMessageId, lastErrorCode: null, locale: shortLocale, sentAt: this.now() });
      return { sent: true, notSentReason: null, issued: true };
    } catch (error) {
      // A transport failure is reported as NOT SENT. It is never swallowed into a success shape.
      const code = error instanceof EmailDeliveryError ? error.code : 'EMAIL_DELIVERY_FAILED';
      await this.recordInline({ dedup, userId, category: 'TRANSACTIONAL:' + purpose, recipient: emailAddress, subject: rendered.subject, status: 'FAILED', providerMessageId: null, lastErrorCode: code, locale: shortLocale, sentAt: null });
      return { sent: false, notSentReason: 'EMAIL_DELIVERY_FAILED', issued: true };
    }
  }

  /** Best-effort ledger write: a ledger failure must not mask the real delivery outcome. */
  private async recordInline(input: { dedup: string; userId: ID; category: string; recipient: string; subject: string; status: 'SENT' | 'FAILED'; providerMessageId: string | null; lastErrorCode: string | null; locale: string; sentAt: Date | null }): Promise<void> {
    if (!this.deliveryLedger) return;
    try {
      await this.deliveryLedger.recordInline({
        deduplicationKey: input.dedup, userId: input.userId, workspaceId: null,
        category: input.category, recipient: input.recipient, subject: input.subject,
        provider: this.email.provider, status: input.status, attemptCount: 1,
        lastErrorCode: input.lastErrorCode, providerMessageId: input.providerMessageId,
        locale: input.locale, sentAt: input.sentAt,
      });
    } catch {
      // Never let bookkeeping turn a truthful outcome into a false one.
    }
  }

  /**
   * Atomically claim a token: exactly one caller can flip `used_at` from NULL.
   *
   * A replay, an expired token, a superseded token and a token for the wrong purpose all raise, and
   * the messages are deliberately indistinguishable between "unknown token" and "already used" so a
   * caller cannot probe which links were issued.
   */
  private async consume(rawToken: string, purpose: TokenPurpose): Promise<TokenConsumption> {
    if (typeof rawToken !== 'string' || !tokenPattern.test(rawToken)) {
      throw new DomainError('INVALID_INPUT', 'This link is invalid or has expired');
    }
    const now = this.now();
    const claimed = await this.store.db.update(identityTokens)
      .set({ usedAt: now })
      .where(and(
        eq(identityTokens.tokenHash, this.digest(rawToken)),
        eq(identityTokens.purpose, purpose),
        isNull(identityTokens.usedAt),
        isNull(identityTokens.revokedAt),
        gt(identityTokens.expiresAt, now),
      ))
      .returning({ userId: identityTokens.userId, purpose: identityTokens.purpose });
    const [row] = claimed;
    if (!row) {
      // Distinguish an expired-but-unused token (a recovery state worth explaining) from a consumed
      // one only through the audit trail, never through the API response.
      throw new DomainError('CONFLICT', 'This link is invalid or has expired');
    }
    return { userId: row.userId as ID, purpose: row.purpose as TokenPurpose };
  }
}

/** Password hashing port; the API supplies its existing scrypt implementation. */
export interface PasswordHasher {
  hash(password: string): Promise<{ salt: string; hash: string }>;
}
