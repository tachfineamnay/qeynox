import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DomainError, type PlatformPermission, type PlatformPrincipal } from '@qeynox/domain';
import {
  effectiveRegistrationInvitationStatus,
  type RegistrationInvitationRow,
  type RegistrationInvitationStatus,
  type RegistrationStore,
} from '@qeynox/persistence';
import type { PlatformAdminService, PlatformPermissionContext } from './platform-admin';
import { BETA_MAX_LIFETIME_MS, BETA_MIN_LIFETIME_MS } from './beta-access';

/**
 * MISSION A21.05 — ONE authoritative, server-side registration policy.
 *
 * `QEYNOX_REGISTRATION_MODE` decides whether `POST /v1/auth/register` accepts a signup. The API
 * enforces it on every request and publishes it on `GET /v1/auth/registration-policy`; the web
 * register page renders ONLY what that endpoint reports (it has no registration switch of its own), so
 * the page can never offer an enabled form the API would refuse by configuration.
 *
 * - `CLOSED` (default; unset or blank): every signup is refused with NOT_CONFIGURED.
 * - `INVITE_ONLY`: a signup must present a valid, operator-issued registration invitation bound to the
 *   same e-mail. Redeeming it creates the account, the workspace AND an ACTIVE beta grant atomically.
 *   This is the mode for the invite-only beta.
 * - `OPEN`: anyone may sign up. An uninvited signup gets a workspace WITHOUT beta enrollment (the
 *   A21.02 gate keeps it NOT_ENROLLED: it cannot launch beta missions); a signup that presents an
 *   invitation must still redeem it validly and is then enrolled exactly as in INVITE_ONLY.
 *
 * Any other value resolves to CLOSED (fail closed) and is reported as a configuration error, so a
 * typo can never open registration. Refusing at boot instead (as QEYNOX_COMMERCE_MODE does) would take
 * login and every other identity route down with it; closing only registration is the narrower
 * failure.
 *
 * Deprecated alias: when `QEYNOX_REGISTRATION_MODE` is unset or blank, the pre-A21.05 variable
 * `QEYNOX_ALLOW_REGISTRATION=true` still means OPEN (any other value means CLOSED), so existing
 * deployments keep their behaviour. `QEYNOX_REGISTRATION_MODE` always wins when it is set. The old
 * web-only `QEYNOX_REGISTRATION_ENABLED` is no longer read anywhere.
 */
export const REGISTRATION_MODES = ['CLOSED', 'INVITE_ONLY', 'OPEN'] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];
export const REGISTRATION_MODE_ENV = 'QEYNOX_REGISTRATION_MODE';
export const LEGACY_ALLOW_REGISTRATION_ENV = 'QEYNOX_ALLOW_REGISTRATION';
export const REGISTRATION_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REGISTRATION_INVITATION_MIN_TTL_MS = 5 * 60 * 1000;
const invitationTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export type RegistrationPolicySource = 'MODE' | 'LEGACY_ALLOW_REGISTRATION' | 'DEFAULT';

export interface RegistrationPolicy {
  readonly mode: RegistrationMode;
  /** True for INVITE_ONLY and OPEN. */
  readonly acceptingRegistrations: boolean;
  /** True only for INVITE_ONLY. */
  readonly invitationRequired: boolean;
  readonly source: RegistrationPolicySource;
  /** Set when the configured value was unsupported and the policy failed closed. */
  readonly configurationError: 'UNSUPPORTED_REGISTRATION_MODE' | null;
}

/** The public projection served to the web register page (no configuration internals). */
export interface PublicRegistrationPolicy {
  readonly mode: RegistrationMode;
  readonly acceptingRegistrations: boolean;
  readonly invitationRequired: boolean;
}

function policyOf(mode: RegistrationMode, source: RegistrationPolicySource, configurationError: RegistrationPolicy['configurationError'] = null): RegistrationPolicy {
  return { mode, acceptingRegistrations: mode !== 'CLOSED', invitationRequired: mode === 'INVITE_ONLY', source, configurationError };
}

export function resolveRegistrationPolicy(env: Readonly<Record<string, string | undefined>>): RegistrationPolicy {
  const raw = (env[REGISTRATION_MODE_ENV] ?? '').trim();
  if (raw) {
    return (REGISTRATION_MODES as readonly string[]).includes(raw)
      ? policyOf(raw as RegistrationMode, 'MODE')
      : policyOf('CLOSED', 'MODE', 'UNSUPPORTED_REGISTRATION_MODE');
  }
  if ((env[LEGACY_ALLOW_REGISTRATION_ENV] ?? '').trim() !== '') {
    return policyOf(env[LEGACY_ALLOW_REGISTRATION_ENV] === 'true' ? 'OPEN' : 'CLOSED', 'LEGACY_ALLOW_REGISTRATION');
  }
  return policyOf('CLOSED', 'DEFAULT');
}

/** Read per call (not cached) so the served policy and the enforced policy can never diverge. */
export function registrationPolicyFromEnvironment(): RegistrationPolicy {
  return resolveRegistrationPolicy(process.env);
}

export function publicRegistrationPolicy(policy: RegistrationPolicy): PublicRegistrationPolicy {
  return { mode: policy.mode, acceptingRegistrations: policy.acceptingRegistrations, invitationRequired: policy.invitationRequired };
}

export function isWellFormedRegistrationInvitationToken(token: string): boolean { return invitationTokenPattern.test(token); }

export function hashRegistrationInvitationToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

/**
 * Decides how a signup must be handled under the policy. Throws the refusal; otherwise returns the
 * invitation digest to redeem (undefined = uninvited OPEN signup). A token presented in OPEN mode is
 * still redeemed (and must be valid), so an invited person is always enrolled in the beta.
 */
export function registrationAdmission(policy: RegistrationPolicy, invitationToken: string | undefined): { invitationTokenHash: string | undefined } {
  if (!policy.acceptingRegistrations) throw new DomainError('NOT_CONFIGURED', 'Registration is disabled');
  const token = invitationToken?.trim() ?? '';
  if (!token) {
    if (policy.invitationRequired) throw new DomainError('INVITATION_INVALID', 'A valid registration invitation is required');
    return { invitationTokenHash: undefined };
  }
  if (!isWellFormedRegistrationInvitationToken(token)) throw new DomainError('INVITATION_INVALID', 'A valid registration invitation is required');
  return { invitationTokenHash: hashRegistrationInvitationToken(token) };
}

// ── Operator side ──────────────────────────────────────────────────────────────────────────────

const readPermissions: readonly PlatformPermission[] = ['ADMINISTRATION', 'SUPPORT'];
const targetType = 'REGISTRATION_INVITATION';
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RegistrationInvitationInput {
  readonly email: string;
  readonly betaExpiresAt: string;
  readonly missionQuota: number;
  readonly concurrentLimit: number;
  readonly maxProviderSpendMinor: number;
  readonly currency: string;
  readonly reason: string;
}

export interface RegistrationInvitationView {
  readonly invitationId: string;
  readonly email: string;
  readonly status: RegistrationInvitationStatus;
  readonly storedStatus: RegistrationInvitationStatus;
  readonly expiresAt: string;
  readonly betaExpiresAt: string;
  readonly missionQuota: number;
  readonly concurrentLimit: number;
  readonly maxProviderSpendMinor: number;
  readonly currency: string;
  readonly createdBy: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly redeemedAt: string | null;
  readonly redeemedUserId: string | null;
  readonly redeemedWorkspaceId: string | null;
  readonly betaGrantId: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
}

export interface RegistrationInvitationCreatedView {
  readonly invitation: RegistrationInvitationView;
  /** Shown exactly once; only its SHA-256 digest is stored. */
  readonly invitationToken: string;
  /** Relative path of the register page with the token pre-filled (the operator delivers it manually). */
  readonly registrationPath: string;
  readonly delivery: { readonly email: 'BLOCKED'; readonly reason: 'MANUAL_DELIVERY_REQUIRED' };
}

export interface RegistrationInvitationPage {
  readonly items: readonly RegistrationInvitationView[];
  readonly limit: number;
}

const iso = (value: Date | null): string | null => value ? value.toISOString() : null;

export function registrationInvitationView(row: RegistrationInvitationRow, now: Date): RegistrationInvitationView {
  return {
    invitationId: row.id, email: row.email, status: effectiveRegistrationInvitationStatus(row, now), storedStatus: row.status,
    expiresAt: row.expiresAt.toISOString(), betaExpiresAt: row.betaExpiresAt.toISOString(), missionQuota: row.missionQuota,
    concurrentLimit: row.concurrentLimit, maxProviderSpendMinor: row.maxProviderSpendMinor, currency: row.currency,
    createdBy: row.createdBy, reason: row.reason, createdAt: row.createdAt.toISOString(), redeemedAt: iso(row.redeemedAt),
    redeemedUserId: row.redeemedUserId, redeemedWorkspaceId: row.redeemedWorkspaceId, betaGrantId: row.betaGrantId,
    revokedAt: iso(row.revokedAt), revokedBy: row.revokedBy, revokeReason: row.revokeReason,
  };
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export interface PlatformRegistrationInvitationOptions {
  readonly now?: () => Date;
  readonly generateToken?: () => string;
}

/**
 * Operator management of registration invitations (platform routes). Reads: ADMINISTRATION or
 * SUPPORT. Issue and revoke: ADMINISTRATION only, with a written justification; every decision is
 * audited in platform_admin_audit. No self-invitation: an operator can never invite their own e-mail.
 */
export class PlatformRegistrationInvitationService {
  private readonly now: () => Date;
  private readonly generateToken: () => string;
  constructor(
    private readonly store: RegistrationStore,
    private readonly platform: PlatformAdminService,
    options: PlatformRegistrationInvitationOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.generateToken = options.generateToken ?? (() => randomBytes(32).toString('base64url'));
  }

  async list(principal: PlatformPrincipal, input: { email?: string | undefined; status?: RegistrationInvitationStatus | undefined; limit?: number | undefined }): Promise<RegistrationInvitationPage> {
    await this.platform.requireAnyPermission(principal, readPermissions, { action: 'LIST_REGISTRATION_INVITATIONS', targetType });
    const limit = integerIn(input.limit, 1, 100) ? input.limit : 50;
    const now = this.now();
    // Stored PENDING rows may be time-expired, so filtering happens on the EFFECTIVE status.
    const stored: RegistrationInvitationStatus[] | undefined = input.status === undefined ? undefined
      : input.status === 'EXPIRED' ? ['PENDING', 'EXPIRED'] : [input.status];
    const rows = await this.store.listInvitations({ email: input.email?.trim().toLowerCase(), statuses: stored, limit: input.status === undefined ? limit : 100 });
    const items = rows.map(row => registrationInvitationView(row, now)).filter(view => input.status === undefined || view.status === input.status).slice(0, limit);
    return { items, limit };
  }

  async issue(principal: PlatformPrincipal, input: RegistrationInvitationInput): Promise<RegistrationInvitationCreatedView> {
    await this.platform.requirePermission(principal, 'ADMINISTRATION', { action: 'ISSUE_REGISTRATION_INVITATION', targetType });
    const now = this.now();
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 10 || reason.length > 500) {
      await this.denied(principal, 'ISSUE_REGISTRATION_INVITATION', null, 'INVALID_JUSTIFICATION');
      throw new DomainError('INVALID_INPUT', 'A justification of 10-500 characters is required');
    }
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const betaExpiresAt = new Date(input.betaExpiresAt);
    const lifetime = betaExpiresAt.getTime() - now.getTime();
    const valid = emailPattern.test(email) && email.length <= 320
      && !Number.isNaN(betaExpiresAt.getTime()) && lifetime >= BETA_MIN_LIFETIME_MS && lifetime <= BETA_MAX_LIFETIME_MS
      && integerIn(input.missionQuota, 1, 10_000) && integerIn(input.concurrentLimit, 1, 100)
      && integerIn(input.maxProviderSpendMinor, 0, 100_000_000) && typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency);
    if (!valid) {
      await this.denied(principal, 'ISSUE_REGISTRATION_INVITATION', null, 'INVALID_LIMITS');
      throw new DomainError('INVALID_INPUT', 'A valid e-mail is required; beta expiry must be 5 minutes to 366 days ahead; quota 1-10000, concurrency 1-100, spend cap 0-100000000 minor units, ISO currency');
    }
    const operatorEmail = await this.store.findUserEmail(principal.userId);
    if (operatorEmail !== undefined && operatorEmail.toLowerCase() === email) {
      await this.denied(principal, 'ISSUE_REGISTRATION_INVITATION', null, 'SELF_INVITATION_FORBIDDEN');
      throw new DomainError('DENIED', 'An operator cannot invite their own e-mail address');
    }
    if (await this.store.emailRegistered(email)) {
      // Operator-only signal (operators can already list users); never surfaced to the public.
      await this.denied(principal, 'ISSUE_REGISTRATION_INVITATION', null, 'ACCOUNT_EXISTS');
      throw new DomainError('CONFLICT', 'An account already exists for this e-mail; grant beta access to its workspace instead');
    }
    const token = this.generateToken();
    if (!isWellFormedRegistrationInvitationToken(token)) throw new DomainError('INVALID_STATE', 'Generated invitation token is malformed');
    const invitationId = randomUUID();
    const expiresAt = new Date(Math.min(now.getTime() + REGISTRATION_INVITATION_TTL_MS, betaExpiresAt.getTime()));
    if (expiresAt.getTime() - now.getTime() < REGISTRATION_INVITATION_MIN_TTL_MS) throw new DomainError('INVALID_INPUT', 'The invitation would expire immediately');
    const audit = this.platform.buildAuditRecord({
      actor: principal, targetType, targetId: invitationId, action: 'ISSUE_REGISTRATION_INVITATION', permission: 'ADMINISTRATION', outcome: 'SUCCESS', reason,
      detail: {
        email, expiresAt: expiresAt.toISOString(), betaExpiresAt: betaExpiresAt.toISOString(), missionQuota: input.missionQuota,
        concurrentLimit: input.concurrentLimit, maxProviderSpendMinor: input.maxProviderSpendMinor, currency: input.currency,
      },
    });
    const result = await this.store.createInvitation({
      id: invitationId, email, tokenHash: hashRegistrationInvitationToken(token), expiresAt, betaExpiresAt,
      missionQuota: input.missionQuota, concurrentLimit: input.concurrentLimit, maxProviderSpendMinor: input.maxProviderSpendMinor,
      currency: input.currency, createdBy: principal.userId, reason, createdAt: now,
    }, audit);
    if (result.outcome === 'CONFLICT') {
      await this.denied(principal, 'ISSUE_REGISTRATION_INVITATION', null, 'PENDING_INVITATION_EXISTS', { existingInvitationId: result.existingInvitationId });
      throw new DomainError('CONFLICT', 'A pending invitation already exists for this e-mail; revoke it first');
    }
    return {
      invitation: registrationInvitationView(result.invitation, now),
      invitationToken: token,
      registrationPath: '/en/account/register?invitation=' + token,
      delivery: { email: 'BLOCKED', reason: 'MANUAL_DELIVERY_REQUIRED' },
    };
  }

  async revoke(principal: PlatformPrincipal, invitationId: string, reasonInput: string): Promise<RegistrationInvitationView> {
    await this.platform.requirePermission(principal, 'ADMINISTRATION', { action: 'REVOKE_REGISTRATION_INVITATION', targetType, targetId: invitationId });
    const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
    if (reason.length < 10 || reason.length > 500) {
      await this.denied(principal, 'REVOKE_REGISTRATION_INVITATION', invitationId, 'INVALID_JUSTIFICATION');
      throw new DomainError('INVALID_INPUT', 'A justification of 10-500 characters is required');
    }
    const now = this.now();
    const result = await this.store.revokeInvitation({
      invitationId, actorUserId: principal.userId, reason, at: now,
      buildAudit: row => this.platform.buildAuditRecord({
        actor: principal, targetType, targetId: row.id, action: 'REVOKE_REGISTRATION_INVITATION', permission: 'ADMINISTRATION', outcome: 'SUCCESS', reason,
        detail: { email: row.email },
      }),
    });
    if (result.outcome === 'NOT_FOUND') {
      await this.denied(principal, 'REVOKE_REGISTRATION_INVITATION', invitationId, 'INVITATION_NOT_FOUND');
      throw new DomainError('NOT_FOUND', 'Registration invitation not found');
    }
    if (result.outcome === 'NOT_PENDING') {
      await this.denied(principal, 'REVOKE_REGISTRATION_INVITATION', invitationId, 'INVITATION_NOT_PENDING', { status: result.status });
      throw new DomainError('CONFLICT', 'Only a pending invitation can be revoked (current status: ' + result.status + ')');
    }
    return registrationInvitationView(result.invitation, now);
  }

  recordInputRejection(principal: PlatformPrincipal | undefined, context: PlatformPermissionContext): Promise<void> {
    return this.platform.recordInputRejection(principal, context);
  }

  private async denied(principal: PlatformPrincipal, action: string, targetId: string | null, reason: string, detail?: Record<string, unknown>): Promise<void> {
    await this.platform.recordAudit({ actor: principal, targetType, targetId, action, permission: 'ADMINISTRATION', outcome: 'DENIED', reason, detail: detail ?? null });
  }
}
