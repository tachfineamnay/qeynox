/**
 * TASK 01 backend certification (isolated database only).
 *
 * Boots the real NestJS application (DI graph, global guard and error filter), then exercises
 * authentication, authorization, request validation, persistence and workspace isolation over
 * HTTP. It never calls Hatchet, Hermes, payment or provider networks. A brand-new disposable
 * database is created from QEYNOX_QA_DATABASE_URL and dropped afterwards.
 */
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { runMigrations } from '@qeynox/persistence';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/transport/domain-exception.filter';
import { createIsolatedQaDatabase } from './qa-isolated-database';

let assertions = 0;
function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}
interface HttpResult { readonly status: number; readonly body: unknown }
async function call(base: string, path: string, init: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(base + path, init);
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text) as unknown; } catch { /* plain text body */ }
  return { status: response.status, body };
}
function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
function bearer(token: string): Record<string, string> {
  return { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
}
function errorCode(result: HttpResult): string | undefined {
  return (result.body as { error?: { code?: string } }).error?.code;
}

const emailOne = 'qa-cert-one@example.invalid';
const emailTwo = 'qa-cert-two@example.invalid';
const password = 'certification-passphrase';

async function main(): Promise<void> {
  const qa = await createIsolatedQaDatabase();
  process.env.DATABASE_URL = qa.url;
  let app: INestApplication | undefined;
  try {
    const report = await runMigrations(qa.url);
    assert(report.applied.length === report.total && report.total > 0, 'disposable QA database migrated before boot');
    delete process.env.QEYNOX_ALLOW_REGISTRATION;
    delete process.env.QEYNOX_OPERATOR_USER_IDS;

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    assert(Number.isInteger(address.port) && address.port > 0, 'NestJS dependency graph resolved and HTTP server started');
    const base = 'http://127.0.0.1:' + address.port;

    const registrationDisabled = await call(base, '/v1/auth/register', post({ email: emailOne, password, workspaceName: 'QA Certification' }));
    assert(registrationDisabled.status === 503 && errorCode(registrationDisabled) === 'NOT_CONFIGURED', 'registration fails closed when disabled');

    const unauthenticated = await call(base, '/v1/operations');
    assert(unauthenticated.status === 403 && errorCode(unauthenticated) === 'DENIED', 'bearer session required for tenant routes');
    const malformed = await call(base, '/v1/operations', { headers: { authorization: 'Bearer short' } });
    assert(malformed.status === 403 && errorCode(malformed) === 'DENIED', 'malformed bearer token rejected');

    process.env.QEYNOX_ALLOW_REGISTRATION = 'true';
    const registered = await call(base, '/v1/auth/register', post({ email: emailOne, password, workspaceName: 'QA Certification' }));
    assert(registered.status === 201, 'explicitly enabled registration creates an owner session');
    const session = registered.body as { token: string; userId: string; workspaceId: string };
    assert(typeof session.token === 'string' && typeof session.userId === 'string' && typeof session.workspaceId === 'string', 'session identity returned');
    const owner = bearer(session.token);

    const emptyList = await call(base, '/v1/operations', { headers: owner });
    assert(emptyList.status === 200 && Array.isArray(emptyList.body) && emptyList.body.length === 0, 'new tenant workspace has no operations');

    const created = await call(base, '/v1/operations', { ...post({ title: 'QA certification operation', goal: 'Verify backend HTTP, DI and persistence wiring', constraints: [] }), headers: owner });
    assert(created.status === 201 && (created.body as { status?: string }).status === 'DRAFT', 'operation created in DRAFT');
    const operationId = (created.body as { id: string }).id;
    assert(typeof operationId === 'string' && operationId.length >= 4, 'operation identity returned');

    const list = await call(base, '/v1/operations', { headers: owner });
    assert(list.status === 200 && Array.isArray(list.body) && list.body.length === 1, 'persisted operation is listed for its workspace');
    const timeline = await call(base, '/v1/operations/' + operationId + '/timeline', { headers: owner });
    const events = timeline.body as { kind?: string }[];
    assert(timeline.status === 200 && Array.isArray(events) && events.some(event => event.kind === 'OPERATION_CREATED'), 'audit timeline records operation creation');

    const invalidBody = await call(base, '/v1/operations', { ...post({ title: '', goal: '' }), headers: owner });
    assert(invalidBody.status === 400 && errorCode(invalidBody) === 'INVALID_INPUT', 'request schema validation maps to INVALID_INPUT');
    const missingOperation = await call(base, '/v1/operations/' + '0'.repeat(8) + '/timeline', { headers: owner });
    assert(missingOperation.status === 404 && errorCode(missingOperation) === 'NOT_FOUND', 'unknown operation is not disclosed');

    const operatorUnauthenticated = await call(base, '/v1/operator/configuration');
    assert(operatorUnauthenticated.status === 403 && errorCode(operatorUnauthenticated) === 'DENIED', 'operator configuration requires a session');
    const operatorDisabled = await call(base, '/v1/operator/configuration', { headers: owner });
    assert(operatorDisabled.status === 503 && errorCode(operatorDisabled) === 'NOT_CONFIGURED', 'operator configuration fails closed without an allowlist');
    const unknownRoute = await call(base, '/v1/does-not-exist');
    assert(unknownRoute.status === 404, 'unknown route returns 404');

    const loggedOut = await call(base, '/v1/auth/logout', { method: 'POST', headers: owner });
    assert(loggedOut.status === 201 && (loggedOut.body as { revoked?: boolean }).revoked === true, 'logout revokes the session');
    const revoked = await call(base, '/v1/operations', { headers: owner });
    assert(revoked.status === 403 && errorCode(revoked) === 'DENIED', 'revoked bearer session is rejected');

    const login = await call(base, '/v1/auth/login', post({ email: emailOne, password }));
    assert(login.status === 201, 'login issues a new session');
    const loginToken = (login.body as { token: string }).token;
    const rotated = await call(base, '/v1/auth/rotate', { method: 'POST', headers: bearer(loginToken) });
    assert(rotated.status === 201, 'session rotation succeeds');
    const rotatedToken = (rotated.body as { token: string }).token;
    assert(rotatedToken !== loginToken, 'rotation issues a distinct token');
    const staleAfterRotate = await call(base, '/v1/operations', { headers: bearer(loginToken) });
    assert(staleAfterRotate.status === 403 && errorCode(staleAfterRotate) === 'DENIED', 'rotated-out token is revoked');
    const rotatedWorks = await call(base, '/v1/operations', { headers: bearer(rotatedToken) });
    assert(rotatedWorks.status === 200, 'rotated token authenticates');

    const second = await call(base, '/v1/auth/register', post({ email: emailTwo, password, workspaceName: 'QA Certification Two' }));
    assert(second.status === 201, 'second tenant registration succeeds');
    const secondSession = second.body as { token: string; workspaceId: string };
    const secondOps = await call(base, '/v1/operations', { headers: bearer(secondSession.token) });
    assert(secondOps.status === 200 && Array.isArray(secondOps.body) && secondOps.body.length === 0, 'workspace isolation hides other tenants operations');
    const crossTenant = await call(base, '/v1/operations/' + operationId, { headers: bearer(secondSession.token) });
    assert(crossTenant.status === 404 && errorCode(crossTenant) === 'NOT_FOUND', 'cross-workspace operation access is denied as not found');
    const forgedWorkspace = await call(base, '/v1/operations', { headers: { ...bearer(secondSession.token), 'x-qeynox-workspace': session.workspaceId } });
    assert(forgedWorkspace.status === 403 && errorCode(forgedWorkspace) === 'DENIED', 'workspace header cannot grant membership');

    await app.close();
    app = undefined;
    console.log('Backend certification PASSED:', assertions, 'assertions');
  } finally {
    if (app) await app.close().catch(() => undefined);
    await qa.drop();
    console.log('QA database dropped:', qa.name);
  }
}

main().catch((error: unknown) => {
  console.error('Backend certification FAILED:', error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});




