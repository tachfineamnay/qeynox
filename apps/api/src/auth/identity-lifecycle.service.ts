import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DomainError, type ID } from '@qeynox/domain';
import type { QeyNoxStore, DatabaseConnection } from '@qeynox/persistence';
import {
  IdentityLifecycleService,
  IdentityRateLimiter,
  type EmailTransport,
  type PasswordHasher,
  type RateLimitPolicy,
  type TokenRequestOutcome,
} from '@qeynox/application';
import { DB_CONNECTION, QEYNOX_STORE } from '../database/database.module';
import { EMAIL_TRANSPORT } from '../platform/platform.tokens';
import { AuthService } from './auth.service';
import { hashPassword } from './password';

const emailField = z.email().max(320);
const requestSchema = z.object({ email: emailField });
const tokenSchema = z.object({ token: z.string().min(43).max(256) });
const resetSchema = z.object({ token: z.string().min(43).max(256), password: z.string().min(12).max(256) });

/** Throttling windows. Values are deployment policy, not secrets; each is applied per bucket. */
const policies: Record<string, RateLimitPolicy> = {
  'verify-request': { maxAttempts: 5, windowSeconds: 15 * 60 },
  'verify-confirm': { maxAttempts: 10, windowSeconds: 15 * 60 },
  'reset-request': { maxAttempts: 5, windowSeconds: 15 * 60 },
  'reset-confirm': { maxAttempts: 10, windowSeconds: 15 * 60 },
};

export interface LifecycleStateView {
  readonly verified: boolean;
  readonly verifiedAt: string | null;
  readonly delivery: 'CONFIGURED' | 'NOT_CONFIGURED';
  readonly deliveryReason: string | null;
}

/**
 * HTTP-facing customer identity lifecycle.
 *
 * Every method answers with the transport's real state: `sent` is true only when a message was
 * actually accepted by a configured transport. Requesting verification or recovery for an unknown
 * address returns the same body as for a known one, so these routes cannot be used to discover
 * whether an account exists.
 */
@Injectable()
export class IdentityLifecycleApiService {
  private readonly lifecycle: IdentityLifecycleService;
  private readonly limiter: IdentityRateLimiter;

  constructor(
    @Inject(DB_CONNECTION) connection: DatabaseConnection,
    @Inject(QEYNOX_STORE) store: QeyNoxStore,
    @Inject(EMAIL_TRANSPORT) email: EmailTransport,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {
    const environment = process.env;
    this.lifecycle = new IdentityLifecycleService(store, email, {
      verificationTtlSeconds: numberOr(environment.QEYNOX_VERIFICATION_TTL_SECONDS, 24 * 60 * 60),
      resetTtlSeconds: numberOr(environment.QEYNOX_RESET_TTL_SECONDS, 60 * 60),
      publicBaseUrl: environment.QEYNOX_PUBLIC_URL,
    });
    this.limiter = new IdentityRateLimiter(store);
    void connection;
  }

  /** Verification and delivery state of the authenticated account. */
  async state(userId: ID): Promise<LifecycleStateView> {
    const current = await this.lifecycle.state(userId);
    const delivery = this.lifecycle.deliveryState;
    return { verified: current.verified, verifiedAt: current.verifiedAt, delivery: delivery.status, deliveryReason: delivery.reason };
  }

  /**
   * Request e-mail verification. Throttled per address BEFORE lookup so a flood cannot be used as a
   * timing oracle, and unknown addresses are indistinguishable from known ones.
   */
  async requestVerification(body: unknown): Promise<TokenRequestOutcome> {
    const input = requestSchema.safeParse(body);
    if (!input.success) throw new DomainError('INVALID_INPUT', 'A valid e-mail address is required');
    await this.limiter.consume('verify-request', input.data.email, policies['verify-request']!);
    return this.lifecycle.requestVerification(input.data.email);
  }

  /**
   * Non-consuming pre-flight for the verification landing page. Mirrors inspectReset so a dead link
   * is reported before the customer is offered an action that could only fail.
   */
  async inspectVerification(query: unknown): Promise<{ valid: boolean }> {
    const parsed = z.object({ token: z.string().min(43).max(256) }).safeParse(query);
    if (!parsed.success) return { valid: false };
    return { valid: await this.lifecycle.inspectVerificationToken(parsed.data.token) };
  }

  /**
   * Confirm an address. A successful verification records the fact; the caller keeps the session it
   * already has because verification is not authentication.
   */
  async confirmVerification(body: unknown): Promise<{ verified: true; userId: ID }> {
    const input = tokenSchema.safeParse(body);
    if (!input.success) throw new DomainError('INVALID_INPUT', 'A verification token is required');
    await this.limiter.consume('verify-confirm', input.data.token.slice(0, 16), policies['verify-confirm']!);
    const result = await this.lifecycle.verifyEmail(input.data.token);
    return { verified: true, userId: result.userId };
  }

  async requestReset(body: unknown): Promise<TokenRequestOutcome> {
    const input = requestSchema.safeParse(body);
    if (!input.success) throw new DomainError('INVALID_INPUT', 'A valid e-mail address is required');
    await this.limiter.consume('reset-request', input.data.email, policies['reset-request']!);
    return this.lifecycle.requestPasswordReset(input.data.email);
  }

  /**
   * Pre-flight for the "choose a new password" screen. Never consumes the token: a customer who
   * opens the link twice to read the page must not lock themselves out.
   */
  async inspectReset(query: unknown): Promise<{ valid: boolean }> {
    const parsed = z.object({ token: z.string().min(43).max(256) }).safeParse(query);
    if (!parsed.success) return { valid: false };
    const result = await this.lifecycle.inspectResetToken(parsed.data.token);
    return { valid: result.valid };
  }

  /**
   * Complete recovery. On success every existing session is revoked (the lifecycle service does this
   * inside the token-consuming transaction) and the caller is told the count, never told to assume it.
   */
  async confirmReset(body: unknown): Promise<{ reset: true; revokedSessions: number }> {
    const input = resetSchema.safeParse(body);
    if (!input.success) throw new DomainError('INVALID_INPUT', 'A reset token and a password of at least 12 characters are required');
    await this.limiter.consume('reset-confirm', input.data.token.slice(0, 16), policies['reset-confirm']!);
    const hasher: PasswordHasher = { hash: password => hashPassword(password) };
    const result = await this.lifecycle.resetPassword(input.data.token, input.data.password, hasher);
    return { reset: true, revokedSessions: result.revokedSessions };
  }

  /** Exposed for operators and QA: the transport state the API is actually running with. */
  get delivery(): { status: 'CONFIGURED' | 'NOT_CONFIGURED'; reason: string | null } {
    return this.lifecycle.deliveryState;
  }

  /** Reuses the existing credential verifier; no second password path is introduced. */
  async verifyCredentials(email: string, password: string): Promise<{ userId: ID }> {
    return this.auth.verifyCredentials(email, password);
  }
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 60 ? parsed : fallback;
}
