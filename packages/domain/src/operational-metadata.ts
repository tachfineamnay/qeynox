/** Public operator diagnostics must never turn arbitrary persisted errors into private-content leaks.
 * Only reviewed machine codes pass; messages, SDK names, user reasons and unknown values do not.
 */
const codes = new Set([
  'INVALID_INPUT', 'INVALID_STATE', 'DENIED', 'CONFLICT', 'NOT_FOUND', 'NOT_CONFIGURED',
  'UNAVAILABLE', 'UNSUPPORTED', 'PAYMENT_REQUIRED', 'PAYMENT_NOT_CONFIGURED', 'PAYMENTS_FROZEN',
  'UNKNOWN_OUTCOME', 'BUDGET_EXHAUSTED', 'BETA_ACCESS_REQUIRED', 'BETA_LIMIT_REACHED',
  'UNEXPECTED_EXECUTION_ERROR', 'INVITATION_INVALID', 'INVALID_AGENT_OUTPUT',
  'DISPATCH_LEASE_EXPIRED', 'DISPATCH_INDETERMINATE', 'UNCONFIRMED_DISPATCH',
  'LEASE_EXPIRED', 'INGEST_FAILED', 'EMBEDDINGS_FAILED', 'DELETE_FAILED', 'VERIFY_FAILED', 'STILL_PRESENT',
  'EMAIL_PROVIDER_TIMEOUT', 'EMAIL_PROVIDER_UNREACHABLE', 'EMAIL_PROVIDER_RETRYABLE', 'EMAIL_PROVIDER_REJECTED',
  'EMAIL_DELIVERY_FAILED', 'EMAIL_DELIVERY_NOT_RETRYABLE', 'EMAIL_DELIVERY_ATTEMPTS_EXHAUSTED', 'EMAIL_OUTCOME_UNCERTAIN',
]);
for (const failure of ['AUTH_REJECTED', 'NOT_FOUND', 'ALREADY_EXISTS', 'THROTTLED', 'TIMEOUT', 'UNAVAILABLE']) {
  codes.add('STORAGE_' + failure);
  codes.add('DELETE_FAILED:S3_' + failure);
  codes.add('VERIFY_FAILED:S3_' + failure);
}
export function operationalErrorCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value === 'Unsupported topic') return 'UNSUPPORTED_DISPATCH_TOPIC';
  if (value === 'Invalid event payload') return 'INVALID_DISPATCH_PAYLOAD';
  return typeof value === 'string' && codes.has(value) ? value : 'REDACTED_ERROR';
}
