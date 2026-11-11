# ADR-009: Native short-lived opaque bearer sessions (source-only)

QeyNox API authenticates with random 384-bit opaque bearer tokens, stores only SHA-256 digests in PostgreSQL, and checks active membership on **every request**. Roles OWNER, ADMIN, MEMBER are scoped to verified membership. X-Qeynox-Workspace selects a workspace only if membership exists, never grants it. Anonymous registration is disabled unless QEYNOX_ALLOW_REGISTRATION=true is explicitly set. Credentials use Node scrypt with per-user 192-bit salt and comparison via timingSafeEqual. Six failed login attempts lock the credential temporarily.

Sessions expire after 24 hours and can be revoked or rotated. No cookie authentication is used in this API, so CSRF cookies are not applicable; browsers must never persist bearer tokens in localStorage. Consumer session handling and stronger risk controls (IP rate limiting, email verification, password recovery, optional MFA, abuse mitigation) remain follow-up work before public use.

No route trusts arbitrary userId/workspaceId supplied as a principal. The worker is not an implicit global admin; job origin and scopes must be verified separately before it can bypass API session guards.

All code UNTESTED, NOT BUILT, NOT DEPLOYED. Never expose real users before certification.
