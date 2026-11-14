/**
 * Explicit global platform administrator bootstrap (CLI only, never an HTTP endpoint).
 *
 * Reuses the existing identity credentials (scrypt) and the platform assignment store. It refuses
 * to run without an explicit environment gate, never prints or stores the password in plain text,
 * and creates no workspace membership: a platform account is not a workspace role.
 *
 * Usage (repository root):
 *   QEYNOX_PLATFORM_BOOTSTRAP_ALLOW=true pnpm admin:bootstrap -- \
 *     --email operator@example.invalid --role PLATFORM_ADMIN --confirm \
 *     --reason "initial platform operator"
 *
 * The password is read from QEYNOX_BOOTSTRAP_PASSWORD only when the identity account must be
 * created. When the account already exists, only the platform assignment is added.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  connectDatabase,
  identityCredentials,
  identityUsers,
  platformAdminAssignments,
  platformAdminAudit,
  platformAdminSessions,
} from '@qeynox/persistence';
import { isPlatformRole } from '@qeynox/domain';
import { hashPassword } from '../src/auth/password';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return typeof value === 'string' && !value.startsWith('--') ? value : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes('--' + name);
}

async function main(): Promise<void> {
  if (process.env.QEYNOX_PLATFORM_BOOTSTRAP_ALLOW !== 'true') {
    throw new Error('QEYNOX_PLATFORM_BOOTSTRAP_ALLOW=true is required for an explicit bootstrap');
  }
  if (process.env.NODE_ENV === 'production' || process.env.QEYNOX_DEPLOYMENT_ENV === 'production') {
    throw new Error('Refusing to bootstrap platform administrators on a production deployment');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!flag('confirm')) throw new Error('--confirm is required: this grants global QeyNox authority');

  const email = (argument('email') ?? '').trim().toLowerCase();
  if (!emailPattern.test(email) || email.length > 320) throw new Error('--email must be a valid address');
  const roleArgument = argument('role');
  if (!isPlatformRole(roleArgument)) {
    throw new Error('--role must be one of PLATFORM_ADMIN, SUPPORT, OPERATIONS, AUDITOR');
  }
  const role = roleArgument;
  const reason = (argument('reason') ?? '').trim();
  if (reason.length < 5 || reason.length > 500) throw new Error('--reason must contain 5-500 characters');

  const connection = connectDatabase(databaseUrl);
  try {
    const db = connection.db;
    const [existing] = await db.select().from(identityUsers).where(eq(identityUsers.email, email)).limit(1);
    if (existing?.disabledAt) throw new Error('The identity account is disabled');
    let userId = existing?.id;
    let createdIdentity = false;
    if (!userId) {
      const password = process.env.QEYNOX_BOOTSTRAP_PASSWORD ?? '';
      if (password.length < 12 || password.length > 256) {
        throw new Error('QEYNOX_BOOTSTRAP_PASSWORD (12-256 characters) is required to create the identity account');
      }
      const credential = await hashPassword(password);
      userId = randomUUID();
      const newUserId = userId;
      await db.transaction(async tx => {
        await tx.insert(identityUsers).values({ id: newUserId, email, locale: 'en' });
        await tx.insert(identityCredentials).values({ userId: newUserId, salt: credential.salt, passwordHash: credential.hash });
      });
      createdIdentity = true;
    }
    const targetUserId = userId;
    if (!targetUserId) throw new Error('Identity account could not be resolved');
    const [assigned] = await db.select().from(platformAdminAssignments)
      .where(and(
        eq(platformAdminAssignments.userId, targetUserId),
        eq(platformAdminAssignments.role, role),
        eq(platformAdminAssignments.status, 'ACTIVE'),
      )).limit(1);
    if (assigned) {
      console.log('Platform assignment already active; nothing changed. The password was never logged.');
      console.log(JSON.stringify({ userId: targetUserId, email, role, assignmentId: assigned.id, createdIdentity: false, changed: false }, null, 2));
      return;
    }
    const now = new Date();
    const assignmentId = randomUUID();
    await db.transaction(async tx => {
      await tx.insert(platformAdminAssignments).values({
        id: assignmentId, userId: targetUserId, role, status: 'ACTIVE',
        grantedBy: 'BOOTSTRAP_CLI', grantReason: reason, grantedAt: now,
      });
      // A grant changes the authority set: existing platform sessions must be re-authenticated.
      await tx.update(platformAdminSessions).set({ revokedAt: now })
        .where(and(eq(platformAdminSessions.userId, targetUserId), isNull(platformAdminSessions.revokedAt)));
      await tx.insert(platformAdminAudit).values({
        id: randomUUID(), actorUserId: null, actorSessionId: null,
        targetType: 'PLATFORM_ASSIGNMENT', targetId: assignmentId,
        action: 'BOOTSTRAP_ASSIGN_PLATFORM_ROLE', permission: null, outcome: 'SUCCESS',
        reason: null,
        detail: { role, targetUserId, grantReason: reason, source: 'BOOTSTRAP_CLI', actor: 'unauthenticated CLI' },
        happenedAt: now,
      });
    });
    console.log('Platform administrator bootstrapped. The password was never logged.');
    console.log(JSON.stringify({ userId: targetUserId, email, role, assignmentId, createdIdentity, changed: true }, null, 2));
    console.log('Next: POST /v1/platform/auth/login with this identity. No workspace membership was created.');
  } finally {
    await connection.close();
  }
}

main().catch(error => {
  console.error('Platform bootstrap FAILED:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});