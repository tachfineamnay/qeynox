// MISSION A03 — publication-pages HTTP QA (fixture-free, EN/FR).
//
// Drives the BUILT web app with `next start` under three deployment-environment scenarios and
// asserts the honest publication behavior of the public pages, the 404 page, robots/sitemap and the
// noindex metadata of authenticated routes. No backend fixture is needed: the audited surfaces
// (contact, legal, 404, robots, sitemap, anonymous authed pages) make no API calls.
//
// Expected to run after `pnpm build` in apps/web. Fixture evidence only: the QA server runs in this
// sandbox with QA environment values; nothing here is a product fallback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer as createPortProbe } from 'node:net';
import { createServer } from 'node:http';

const webRoot = fileURLToPath(new URL('..', import.meta.url));

const PENDING_EN = [
  'Legal entity name and legal form',
  'Registered office address',
  'Registration number (trade and companies register)',
  'VAT number, if applicable',
  'Publication director',
  'Hosting provider: name, address and contact',
  'Data protection contact / DPO, if designated',
  'Competent jurisdiction and applicable law',
  'Data retention periods and international transfer safeguards',
  'Legal basis for each processing purpose',
  'Cookie/storage configuration owner and consent tooling, if added later',
];
const PENDING_FR = [
  'Raison sociale et forme juridique de l’éditeur',
  'Adresse du siège social',
  'Numéro d’immatriculation (registre du commerce et des sociétés)',
  'Numéro de TVA intracommunautaire, le cas échéant',
  'Directeur de la publication',
  'Hébergeur : nom, adresse et contact',
  'Contact protection des données / DPO, si désigné',
  'Juridiction compétente et droit applicable',
  'Durées de conservation et garanties de transferts internationaux',
  'Base légale de chaque finalité de traitement',
  'Responsable de la configuration cookies/stockage et outil de consentement, si ajouté ultérieurement',
];

const FULL_ENV = {
  QEYNOX_CONTACT_EMAIL: 'beta-contact@qeynox.example',
  QEYNOX_LEGAL_ENTITY_NAME: 'QeyNox Example Publishing',
  QEYNOX_LEGAL_ENTITY_FORM: 'SAS (QA value)',
  QEYNOX_LEGAL_REGISTERED_OFFICE: 'QA registered office address',
  QEYNOX_LEGAL_REGISTRATION_NUMBER: 'QA-RCS-000000',
  QEYNOX_LEGAL_PUBLICATION_DIRECTOR: 'QA publication director',
  QEYNOX_HOSTING_PROVIDER_NAME: 'QA Hosting Provider',
  QEYNOX_HOSTING_PROVIDER_ADDRESS: 'QA hosting address',
  QEYNOX_HOSTING_PROVIDER_CONTACT: 'QA hosting contact',
  QEYNOX_LEGAL_JURISDICTION: 'QA jurisdiction and applicable law',
  QEYNOX_LEGAL_RETENTION_TRANSFERS: 'QA retention and transfer safeguards',
  QEYNOX_LEGAL_LEGAL_BASIS: 'QA legal basis per purpose',
  QEYNOX_LEGAL_VAT_NUMBER: 'QA VAT number',
  QEYNOX_LEGAL_DPO_CONTACT: 'QA data-protection contact',
  QEYNOX_LEGAL_COOKIE_OWNER: 'QA cookie configuration owner',
};

let assertions = 0;
function ok(message) { assertions++; console.log('  ok: ' + message); }

// Minimal fixture API (test infrastructure only): every authenticated route answers 404 NOT_FOUND so
// the services detail page exercises its notFound() boundary. Never part of the application.
async function startFixture() {
  const backend = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'QA fixture: not found' } }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  return { url: `http://127.0.0.1:${backend.address().port}`, close: () => new Promise(resolve => backend.close(resolve)) };
}

async function startApp(extraEnv) {
  const probe = createPortProbe();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
    cwd: webRoot,
    env: { ...process.env, ...extraEnv, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  app.stdout.on('data', c => { logs += c; });
  app.stderr.on('data', c => { logs += c; });
  let ready = false;
  for (let i = 0; i < 60 && app.exitCode === null; i++) {
    try { await fetch(`http://127.0.0.1:${port}/en`); ready = true; break; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  assert.ok(ready, 'next start became ready\n' + logs);
  return { port, stop: () => new Promise(resolve => { app.kill('SIGTERM'); app.on('exit', resolve); }) };
}

async function get(port, path, cookie) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  return { status: response.status, html: await response.text() };
}

function assertPending(html, labels) {
  for (const label of labels) assert.ok(html.includes(label), 'pending item rendered: ' + label);
}
function assertNoPending(html) {
  // The pending block carries a unique title/intro; the labels alone are not a reliable signal
  // once the same names appear inside the verified-details block.
  assert.ok(!html.includes('To be completed before publication'), 'pending block absent');
  assert.ok(!html.includes('À compléter avant publication'), 'pending block absent (FR)');
}

console.log('Scenario A — no publication values configured (the shipped default state)');
{
  const fixture = await startFixture();
  const { port, stop } = await startApp({ QEYNOX_API_URL: fixture.url });
  const qaCookie = 'qx-session=' + encodeURIComponent(JSON.stringify({ token: 'q'.repeat(64), workspaceId: 'workspace_qa', expiresAt: '2099-01-01T00:00:00.000Z' }));
  try {
    const contactEn = await get(port, '/en/contact');
    assert.equal(contactEn.status, 200);
    assert.ok(contactEn.html.includes('Public contact address: to be completed before publication.'), 'EN pending contact line');
    assert.ok(!contactEn.html.includes('mailto:'), 'no invented mailto link');
    assert.match(contactEn.html, /<html lang="en"/);
    ok('EN contact page shows the honest pending state (no mailto)');
    const contactFr = await get(port, '/fr/contact');
    assert.equal(contactFr.status, 200);
    assert.ok(contactFr.html.includes('Adresse de contact publique : à compléter avant publication.'), 'FR pending contact line');
    assert.ok(!contactFr.html.includes('mailto:'), 'no invented mailto link');
    assert.match(contactFr.html, /<html lang="fr"/);
    ok('FR contact page shows the same honest state in French');
    const noticeEn = await get(port, '/en/legal/notice');
    assert.equal(noticeEn.status, 200);
    assertPending(noticeEn.html, PENDING_EN);
    assert.ok(noticeEn.html.includes('To be completed before publication'), 'pending block title');
    assert.ok(!noticeEn.html.includes('Verified publication details'), 'no verified block while nothing is verified');
    ok('EN legal notice lists every pending field and no verified block');
    const noticeFr = await get(port, '/fr/legal/notice');
    assert.equal(noticeFr.status, 200);
    assertPending(noticeFr.html, PENDING_FR);
    ok('FR legal notice lists every pending field in French');
    for (const path of ['/en/legal/privacy', '/en/legal/terms', '/fr/legal/privacy', '/fr/legal/terms']) {
      const page = await get(port, path);
      assert.equal(page.status, 200);
      assert.ok(page.html.includes('To be completed before publication') || page.html.includes('À compléter avant publication'));
    }
    ok('privacy and terms pages carry the pending block in both locales');
    const cookiesEn = await get(port, '/en/legal/cookies');
    assert.equal(cookiesEn.status, 200);
    assert.ok(cookiesEn.html.includes('No analytics or advertising'), 'cookies page keeps its truthful content');
    ok('cookies page unchanged (no placeholder block by design)');
    const footerEn = contactEn.html.includes('Legal data to be completed before publication.');
    assert.ok(footerEn, 'footer pending warning shows while fields are pending');
    ok('footer carries the pending warning in the unverified state');
    const missing = await get(port, '/en/definitely-not-a-page');
    assert.equal(missing.status, 404);
    assert.ok(missing.html.includes('Page not found') && missing.html.includes('Page introuvable'), 'bilingual 404 message');
    const badLocale = await get(port, '/es');
    assert.equal(badLocale.status, 404);
    assert.ok(badLocale.html.includes('Page introuvable'), 'unsupported locale also answers with the bilingual 404');
    const badOffer = await get(port, '/en/services/definitely-not-an-offer', qaCookie);
    // The [lang] not-found boundary renders the bilingual not-found UI inside the correct locale
    // shell. Honest nuance (documented in the publication checklist): because the dynamic page has
    // already streamed when notFound() fires, Next 16 may answer 200 with the not-found UI (soft
    // 404) — unmatched URLs and unsupported locales DO answer a real 404 (asserted above).
    assert.ok(badOffer.status === 404 || badOffer.status === 200, 'not-found boundary reached (status ' + badOffer.status + ')');
    assert.match(badOffer.html, /<html lang="en"/, 'the boundary renders in the locale shell');
    assert.ok(badOffer.html.includes('Page not found') && badOffer.html.includes('Page introuvable'), 'bilingual not-found UI');
    ok('missing offer id renders the locale-shell not-found boundary (bilingual; streamed status ' + badOffer.status + ')');
    const robots = await (await fetch(`http://127.0.0.1:${port}/robots.txt`)).text();
    assert.match(robots, /Disallow: \/admin/);
    assert.match(robots, /Disallow: \/\*\/services/, 'session-gated catalogue is disallowed');
    const sitemap = await (await fetch(`http://127.0.0.1:${port}/sitemap.xml`)).text();
    assert.match(sitemap, /\/en\/contact/);
    assert.doesNotMatch(sitemap, /\/mydash|\/missions|\/services\?|\/admin/);
    ok('robots.txt disallows the session-gated catalogue; sitemap stays public-only');
    for (const path of ['/en/mydash', '/en/account', '/en/soul', '/en/services']) {
      const page = await get(port, path);
      assert.equal(page.status, 200);
      assert.match(page.html, /<meta name="robots" content="noindex, nofollow"\/>/, 'noindex on ' + path);
    }
    ok('authenticated routes carry robots noindex/nofollow metadata');
    const publicMeta = await get(port, '/en/contact');
    assert.doesNotMatch(publicMeta.html, /name="robots"/, 'public contact page stays indexable');
    ok('public pages remain indexable (no accidental noindex)');
  } finally { await stop(); await fixture.close(); }
}

console.log('Scenario B — every verified value supplied by the operator (runtime env)');
{
  const { port, stop } = await startApp(FULL_ENV);
  try {
    const contactEn = await get(port, '/en/contact');
    assert.equal(contactEn.status, 200);
    assert.ok(contactEn.html.includes('mailto:beta-contact@qeynox.example'), 'verified contact renders as mailto');
    assert.ok(!contactEn.html.includes('Public contact address: to be completed before publication.'), 'no pending contact line');
    ok('verified public contact address is published (EN)');
    const contactFr = await get(port, '/fr/contact');
    assert.ok(contactFr.html.includes('mailto:beta-contact@qeynox.example'), 'verified contact renders as mailto (FR)');
    ok('verified public contact address is published (FR)');
    const noticeEn = await get(port, '/en/legal/notice');
    assert.equal(noticeEn.status, 200);
    assertNoPending(noticeEn.html, PENDING_EN);
    assert.ok(noticeEn.html.includes('Verified publication details'), 'verified block renders');
    assert.ok(noticeEn.html.includes('QeyNox Example Publishing'), 'verified entity name renders');
    assert.ok(noticeEn.html.includes('QA Hosting Provider'), 'verified hosting name renders');
    ok('legal notice renders the verified publication details and no pending list');
    const privacyEn = await get(port, '/en/legal/privacy');
    assert.ok(privacyEn.html.includes('QA legal basis per purpose') && privacyEn.html.includes('QA retention and transfer safeguards'));
    ok('privacy page renders the verified legal basis and retention details');
    assert.ok(!noticeEn.html.includes('Legal data to be completed before publication.'), 'footer pending warning disappears once every field is verified');
    ok('footer warning is gone in the fully verified state');
  } finally { await stop(); }
}

console.log('Scenario C — an INVALID configured contact address fails closed');
{
  const { port, stop } = await startApp({ QEYNOX_CONTACT_EMAIL: 'not-a-valid-address' });
  try {
    const contactEn = await get(port, '/en/contact');
    assert.equal(contactEn.status, 200);
    assert.ok(!contactEn.html.includes('mailto:'), 'an invalid address is never linked');
    assert.ok(!contactEn.html.includes('not-a-valid-address'), 'an invalid value is never rendered');
    assert.ok(contactEn.html.includes('Public contact address: to be completed before publication.'), 'honest pending line instead');
    ok('invalid contact address never reaches the page (fail closed, EN/FR identical)');
    const contactFr = await get(port, '/fr/contact');
    assert.ok(!contactFr.html.includes('not-a-valid-address'), 'invalid value absent (FR)');
    ok('invalid contact address never reaches the page (FR)');
  } finally { await stop(); }
}

console.log('\nPublication pages QA passed: ' + assertions + ' assertions (fixture evidence only: QA env values on a QA server).');
