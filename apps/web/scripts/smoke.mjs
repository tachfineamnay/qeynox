// Isolated HTTP contract fixtures for QA only. Never imported by the application.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer as createPortProbe } from 'node:net';

let mode = 'empty';
const token = 'q'.repeat(64);
const backend = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/auth/login' && req.method === 'POST') { res.end(JSON.stringify({ token, workspaceId: 'workspace_qa', expiresAt: '2099-01-01T00:00:00.000Z' })); return; }
  assert.equal(req.headers.authorization, `Bearer ${token}`);
  assert.equal(req.headers['x-qeynox-workspace'], 'workspace_qa');
  const operation = { id: 'operation_qa', title: 'QA mission workspace', status: 'RUNNING', version: 3, lastActivityAt: '2026-01-01T12:00:00.000Z' };
  const citation = { sourceId: 'source_qa', provider: 'QA source', uri: mode === 'unsafe-source' ? 'javascript:alert(1)' : 'https://example.org/evidence', retrievedAt: operation.lastActivityAt };
  const doc = { id: 'document_qa', operationId: operation.id, revisionId: 'revision_qa', version: 1, title: 'QA evidence document', objective: 'QA objective', status: 'PARTIAL', scope: [], nextActions: ['Review missing evidence'], limitations: ['QA limitation'], unresolved: ['claim_qa'], createdAt: operation.lastActivityAt, citations: [citation], findings: [{ claimId: 'claim_qa', statement: 'QA finding', status: 'UNVERIFIED', sourceIds: ['source_qa'], attemptId: 'attempt_qa', limitations: ['Needs review'], citations: [citation] }] };
  let payload;
  if (req.url === '/v1/operations/operation_qa') payload = operation;
  if (req.url === '/v1/mydash/operations/operation_qa/summary') payload = { operationId: operation.id, status: 'RUNNING', stepCount: 3, completedSteps: 1, pendingApprovals: 0, lastSequence: 1 };
  if (req.url === '/v1/operations/operation_qa/timeline') payload = [{ id: 'event_qa', kind: 'EXECUTION_REQUESTED', occurredAt: operation.lastActivityAt }];
  if (req.url?.startsWith('/v1/mydash/operations/operation_qa/activity?')) payload = { events: [{ id: 'envelope_qa', eventId: 'event_qa', sequence: 1, kind: 'EXECUTION_REQUESTED', occurredAt: operation.lastActivityAt }], nextCursor: 1, transport: 'POLLING' };
  if (req.url === '/v1/pilot/operations/operation_qa/next-action') payload = { operationId: operation.id, status: 'RUNNING', action: 'WAIT', reason: 'Based on recorded operation state only' };
  if (req.url === '/v1/pilot/overview') payload = [operation];
  if (req.url === '/v1/operations/operation_qa/documents') payload = [doc];
  if (req.url === '/v1/operations/operation_qa/documents/document_qa') payload = doc;
  if (req.url === '/v1/soul/context') payload = [{ id: 'fact_qa', key: 'QA preference', value: 'French', consentId: 'consent_qa', updatedAt: operation.lastActivityAt }];
  if (mode === 'section-failure' && req.url?.endsWith('/documents')) { res.statusCode = 503; res.end(JSON.stringify({ error: { code: 'NOT_CONFIGURED' } })); return; }
  if (req.url?.endsWith('/export/json') || req.url?.endsWith('/export/html')) { res.end(JSON.stringify({ artifactId: 'artifact_qa', sha256: 'a'.repeat(64) })); return; }
  if (req.url?.endsWith('/artifacts/artifact_qa')) { res.end(JSON.stringify({ url: 'https://example.org/qa-only-artifact' })); return; }
  if (payload !== undefined) { res.end(JSON.stringify(payload)); return; }
  assert.equal(req.url, '/v1/mydash/recent?limit=30');
  if (mode === 'denied') { res.statusCode = 403; res.end(JSON.stringify({ error: { code: 'DENIED' } })); }
  else if (mode === 'malformed') res.end(JSON.stringify([{ operationId: 'invalid' }]));
  else res.end(JSON.stringify(mode === 'empty' ? [] : [{ operationId: 'operation_qa', title: 'QA contract fixture', status: 'DRAFT', lastActivityAt: '2026-01-01T12:00:00.000Z' }]));
});
backend.listen(0, '127.0.0.1');
await once(backend, 'listening');
const probe = createPortProbe();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = process.env.QEYNOX_SMOKE_INTERACTIVE === '1' ? 3137 : probe.address().port;
await new Promise(resolve => probe.close(resolve));
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, QEYNOX_API_URL: `http://127.0.0.1:${backend.address().port}`, NEXT_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
app.stdout.on('data', chunk => { logs += chunk; });
app.stderr.on('data', chunk => { logs += chunk; });
const cookie = `qx-session=${encodeURIComponent(JSON.stringify({ token, workspaceId: 'workspace_qa', expiresAt: '2099-01-01T00:00:00.000Z' }))}`;
let assertions = 0;
async function page(path, authenticated = false) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: authenticated ? { cookie } : {} });
  assert.equal(response.status, 200); assertions++;
  const html = await response.text();
  assert.ok(!html.includes(token), 'bearer token must never enter HTML'); assertions++;
  return html;
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (app.exitCode !== null) throw new Error(logs);
    try { await fetch(`http://127.0.0.1:${port}/en`); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  assert.ok(ready, logs);
  if (process.env.QEYNOX_SMOKE_INTERACTIVE === '1') {
    console.log(`QA FIXTURE ONLY: http://127.0.0.1:${port}/en/account (any test email/password; no real credentials).`);
    await new Promise(resolve => process.once('SIGINT', resolve));
    process.exitCode = 0;
  } else {
  const home = await page('/en');
  assert.match(home, /A useful business result, not agent theatre/); assertions++;
  assert.match(home, /rel="canonical"/); assertions++;
  assert.match(home, /name="description"/); assertions++;
  for (const path of ['/en/how-it-works','/en/manifesto','/en/contact','/en/legal/notice','/en/legal/privacy','/en/legal/terms','/en/legal/cookies','/fr/how-it-works']) await page(path);
  const sitemap = await (await fetch(`http://127.0.0.1:${port}/sitemap.xml`)).text();
  assert.match(sitemap, /\/en\/how-it-works/); assertions++;
  assert.match(sitemap, /\/fr\/how-it-works/); assertions++;
  assert.doesNotMatch(sitemap, /\/mydash|\/missions|\/admin/); assertions++;
  const robots = await (await fetch(`http://127.0.0.1:${port}/robots.txt`)).text();
  assert.match(robots, /Disallow: \/admin/); assertions++;
  assert.match(await page('/fr'), /<html lang="fr"/); assertions++;
  assert.match(await page('/en/mydash'), /Sign in to view or save/); assertions++;
  assert.match(await page('/en/capabilities'), /Availability cannot be confirmed/); assertions++;
  assert.match(await page('/en/mydash', true), /No recorded operations were returned/); assertions++;
  mode = 'loaded';
  const loaded = await page('/en/mydash', true);
  assert.match(loaded, /QA contract fixture/); assertions++;
  assert.match(loaded, />Draft<\/span>/); assertions++;
  mode = 'denied';
  assert.match(await page('/en/mydash', true), /Access was denied/); assertions++;
  mode = 'malformed';
  assert.match(await page('/en/mydash', true), /request could not be completed/); assertions++;
  const unknown = await fetch(`http://127.0.0.1:${port}/es`);
  assert.equal(unknown.status, 404); assertions++;
  const mission = await page('/en/missions/operation_qa', true);
  for (const text of ['QA mission workspace', '1 / 3', 'EXECUTION_REQUESTED', 'QA evidence document', 'QA preference', 'Pilot']) { assert.ok(mission.includes(text), text); assertions++; }
  const document = await page('/en/missions/operation_qa/results/document_qa', true);
  for (const text of ['QA finding', 'Unverified', 'https://example.org/evidence', 'QA limitation', 'Partial']) { assert.ok(document.includes(text), text); assertions++; }
  assert.ok(!document.includes('>UNVERIFIED<') && !document.includes('>PARTIAL<'), 'raw document/finding enums must be localized'); assertions++;
  const frenchDocument = await page('/fr/missions/operation_qa/results/document_qa', true);
  assert.ok(frenchDocument.includes('Non vérifié') && frenchDocument.includes('Partiel')); assertions++;
  mode = 'section-failure';
  const partial = await page('/fr/missions/operation_qa', true);
  assert.ok(partial.includes('NOT_CONFIGURED') && partial.includes('QA mission workspace')); assertions++;
  const anonymousMission = await page('/en/missions/operation_qa');
  assert.ok(anonymousMission.includes('SESSION_REQUIRED') && !anonymousMission.includes('QA preference')); assertions++;
  mode = 'unsafe-source';
  const unsafeSource = await page('/en/missions/operation_qa/results/document_qa', true);
  assert.ok(!unsafeSource.includes('href="javascript:') && unsafeSource.includes('No citation available')); assertions++;
  console.log(`PASS: ${assertions} HTTP assertions; EN/FR, session boundary, genuine empty/loaded/denied/malformed states. QA fixtures only; no database or agent runtime used.`);
  }
} finally {
  app.kill();
  backend.closeAllConnections();
  backend.close();
}
