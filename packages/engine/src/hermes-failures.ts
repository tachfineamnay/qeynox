import { DomainError } from '@qeynox/domain';

const recovery = {
  UNAUTHORIZED: 'FIX_HERMES_AUTH',
  PROVIDER_AUTH_REJECTED: 'FIX_VERTEX_IAM_OR_CREDENTIAL',
  PROVIDER_CONFIGURATION: 'FIX_PROVIDER_CONFIGURATION',
  PROVIDER_MODEL_UNAVAILABLE: 'REVIEW_MODEL_REGION_AND_ACCESS',
  PROVIDER_RATE_LIMITED: 'BACKOFF_AND_REVIEW_PROVIDER_QUOTA',
  RATE_LIMITED: 'BACKOFF_AND_RECHECK_RUNTIME',
  TIMEOUT: 'RECONCILE_UNCONFIRMED_RUN',
  CANCELLED: 'RECONCILE_UNCONFIRMED_RUN',
  UNREACHABLE: 'RECHECK_PRIVATE_ENDPOINT',
  NATIVE_TOOLS_DETECTED: 'RESTORE_ISOLATION_AND_REPROBE',
  MALFORMED: 'INVESTIGATE_RUNTIME_CONTRACT',
  INCOMPLETE: 'REVIEW_INCOMPLETE_RUN',
  PROVIDER_FAILURE: 'INVESTIGATE_PROVIDER_FAILURE',
  SERVER_ERROR: 'RECHECK_RUNTIME_AND_RECONCILE',
  BAD_REQUEST: 'REVIEW_REQUEST_CONFIGURATION',
} as const;
export type HermesFailure = keyof typeof recovery;

/** Remote text is used for classification only, never persisted as an operator fact or prompt log. */
export function classifyProviderFailure(text: string): HermesFailure {
  if (/unauthenticated|authentication failed|permission.?denied|invalid.{0,20}(?:credential|token)|(?:credential|service.account).{0,40}(?:missing|expired|invalid)|defaultcredentials|\b(?:401|403)\b/i.test(text)) return 'PROVIDER_AUTH_REJECTED';
  if (/resource.exhausted|quota.exceeded|rate.limit|\b429\b/i.test(text)) return 'PROVIDER_RATE_LIMITED';
  if (/(?:model|publisher|region|location).{0,80}(?:not.found|not.available|unsupported)|\b404\b/i.test(text)) return 'PROVIDER_MODEL_UNAVAILABLE';
  if (/no inference provider|could not.{0,20}(?:resolve|credential)|billing.{0,30}(?:disabled|not.enabled)|google.auth.{0,30}(?:missing|installed)/i.test(text)) return 'PROVIDER_CONFIGURATION';
  return 'PROVIDER_FAILURE';
}

/** Stable allowlisted facts for persisted failure/recovery events. No automatic retry implied. */
export function hermesFailureFacts(error: unknown): { engine: 'hermes'; hermesFailure: HermesFailure; recoveryState: string; serverCancellation: 'UNCONFIRMED' | 'NOT_APPLICABLE' } | undefined {
  const code = error instanceof DomainError ? error.context?.hermesFailure : undefined;
  if (!code || !Object.hasOwn(recovery, code)) return undefined;
  const failure = code as HermesFailure;
  return { engine: 'hermes', hermesFailure: failure, recoveryState: recovery[failure], serverCancellation: failure === 'TIMEOUT' || failure === 'CANCELLED' ? 'UNCONFIRMED' : 'NOT_APPLICABLE' };
}
