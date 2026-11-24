// MISSION A03 — publication readiness release check.
//
// Phase 1 runs deterministic self-tests of the publication-state logic over synthetic environments
// (pure functions, no server). Phase 2 reports the REAL deployment configuration and exits 1 with
// PUBLICATION_BLOCKED while essential verified data is missing — this is an honest release gate, so
// it is EXPECTED to fail until the operator supplies the values listed in
// docs/architecture/PUBLICATION_CHECKLIST.md. No value is ever echoed: reasons name the variable,
// never its content.
//
// Usage: node scripts/qa-publication.mjs   (after `pnpm install`; no build required)
import assert from 'node:assert/strict';

const { publicationState, pendingLabels, publicationBlockers, isValidPublicEmail, CONTACT_EMAIL_ENV } =
  await import('../src/lib/publication.ts');
// lib/site.ts cannot be imported here (extensionless runtime import of ./locales breaks Node ESM),
// so the canonical-site-URL derivation below mirrors it exactly; keep the two in sync.
const SITE_URL = (process.env.QEYNOX_PUBLIC_URL ?? 'https://qeynox.io').replace(/\/+$/, '');

let assertions = 0;
function check(message, run) {
  run();
  assertions++;
  console.log('  ok: ' + message);
}

const fullEnv = {
  QEYNOX_CONTACT_EMAIL: 'contact@example.org',
  QEYNOX_LEGAL_ENTITY_NAME: 'Example SAS',
  QEYNOX_LEGAL_ENTITY_FORM: 'Société par actions simplifiée',
  QEYNOX_LEGAL_REGISTERED_OFFICE: '1 rue Exemple, 75001 Paris, France',
  QEYNOX_LEGAL_REGISTRATION_NUMBER: 'RCS Paris 123 456 789',
  QEYNOX_LEGAL_PUBLICATION_DIRECTOR: 'A. Operator',
  QEYNOX_HOSTING_PROVIDER_NAME: 'Example Hosting SAS',
  QEYNOX_HOSTING_PROVIDER_ADDRESS: '2 rue Exemple, 75002 Paris, France',
  QEYNOX_HOSTING_PROVIDER_CONTACT: 'hosting@example.org',
  QEYNOX_LEGAL_JURISDICTION: 'French law, courts of Paris',
  QEYNOX_LEGAL_RETENTION_TRANSFERS: 'Account data 3 years after last sign-in; EU hosting only.',
  QEYNOX_LEGAL_LEGAL_BASIS: 'Contract performance for service delivery; legitimate interest for security.',
  // Optional fields deliberately absent: they never block.
};

console.log('Phase 1 — publication-state self-tests (synthetic environments)');
check('every field MISSING on an empty environment, and nothing is ready', () => {
  const state = publicationState({});
  assert.equal(state.ready, false);
  assert.equal(state.contactEmail.status, 'MISSING');
  assert.equal(state.pendingGroups.length, state.groups.length);
  assert.equal(state.blockingGroups.length, state.groups.filter(g => g.essential).length);
  assert.equal(state.verifiedVars.length, 0);
});
check('the EN and FR pending lists carry the full registry when nothing is supplied', () => {
  const state = publicationState({});
  const en = pendingLabels(state, 'en');
  const fr = pendingLabels(state, 'fr');
  assert.equal(en.length, fr.length);
  assert.ok(en.includes('Legal entity name and legal form'));
  assert.ok(en.includes('Hosting provider: name, address and contact'));
  assert.ok(en.includes('Legal basis for each processing purpose'));
  assert.ok(fr.includes('Raison sociale et forme juridique de l’éditeur'));
  assert.ok(fr.includes('Hébergeur : nom, adresse et contact'));
});
check('a fully supplied essential set is READY while optional fields stay optional', () => {
  const state = publicationState(fullEnv);
  assert.equal(state.ready, true, 'optional fields must not block');
  assert.equal(state.pendingGroups.map(g => g.key).sort().join(','), 'cookieOwner,dpo,vat');
  assert.equal(state.contactEmail.value, 'contact@example.org');
  assert.equal(state.verifiedVars.length, 11, 'the contact e-mail is tracked separately from the group vars');
});
check('an invalid contact address is INVALID, never verified, and blocks publication', () => {
  for (const bad of ['not-an-email', 'spaces in@example.org', 'user@nodot', '@example.org', 'user@', 'user@@example.org', 'user@-bad-.org', 'a'.repeat(70) + '@example.org', 'user@' + 'a'.repeat(200) + '.org']) {
    const state = publicationState({ [CONTACT_EMAIL_ENV]: bad });
    assert.equal(state.contactEmail.status, 'INVALID', bad);
    assert.equal(state.contactEmail.value, undefined, 'an invalid value is never carried');
    assert.equal(state.ready, false, bad);
    assert.ok(publicationBlockers(state).some(r => r.includes(CONTACT_EMAIL_ENV)));
    assert.ok(!publicationBlockers(state).some(r => r.includes(bad.slice(0, 20))), 'the invalid value is never echoed');
  }
});
check('valid public e-mail shapes are accepted', () => {
  for (const good of ['contact@example.org', 'first.last+tag@sub.example.org', 'USER@EXAMPLE.IO']) {
    assert.equal(isValidPublicEmail(good), true, good);
    assert.equal(publicationState({ [CONTACT_EMAIL_ENV]: good }).contactEmail.status, 'VERIFIED', good);
  }
});
check('supplied text with control characters or oversize length is INVALID and never published', () => {
  for (const bad of ['Acme SAS\u0000x', 'line1\nline2', 'x'.repeat(401)]) {
    const state = publicationState({ QEYNOX_LEGAL_ENTITY_NAME: bad });
    assert.equal(state.groups.find(g => g.key === 'entity').status, 'INVALID');
    assert.equal(state.ready, false);
  }
});
check('an INVALID essential group blocks with a per-variable reason naming the variable', () => {
  const state = publicationState({ ...fullEnv, QEYNOX_HOSTING_PROVIDER_CONTACT: 'bad\u0000value' });
  assert.equal(state.ready, false);
  const reasons = publicationBlockers(state, undefined);
  assert.ok(reasons.some(r => r.includes('QEYNOX_HOSTING_PROVIDER_CONTACT') && r.includes('invalid')));
  assert.ok(!reasons.some(r => r.includes('bad')));
});
check('the site URL must be https', () => {
  const state = publicationState(fullEnv);
  assert.ok(publicationBlockers(state, 'http://qeynox.io').some(r => r.includes('not https')));
  assert.equal(publicationBlockers(state, 'https://qeynox.io').length, 0);
});

console.log('Phase 2 — release report for THIS deployment configuration');
const state = publicationState(process.env);
const reasons = publicationBlockers(state, SITE_URL);
console.log('  Site URL (canonical/sitemap base): ' + SITE_URL);
console.log('  Public contact address: ' + state.contactEmail.status);
for (const group of state.groups) {
  console.log('  [' + group.status + (group.essential ? '/REQUIRED' : '/optional') + '] ' + group.label.en + ' ← ' + group.vars.map(v => v.envVar).join(', '));
}
if (reasons.length > 0) {
  console.log('\nPUBLICATION_BLOCKED — the public release gate stays closed while essential verified data is missing:');
  for (const reason of reasons) console.log('  - ' + reason);
  console.log('\nSupply the values listed in docs/architecture/PUBLICATION_CHECKLIST.md through the web deployment');
  console.log('environment. The pages already render this state honestly; nothing is invented in the meantime.');
  process.exitCode = 1;
} else {
  console.log('\nPUBLICATION_READY — all essential verified publication data is present.');
}
console.log('\nSelf-test assertions passed: ' + assertions);
