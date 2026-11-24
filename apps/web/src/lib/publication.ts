/**
 * MISSION A03 — publication readiness source of truth.
 *
 * Every legal/publication field that must be completed before public launch is read here, from
 * deployment environment variables the operator supplies. Nothing is invented: a field without a
 * verified value is MISSING, a supplied value that fails validation is INVALID (and is never
 * rendered), and only VERIFIED values reach the public pages or count toward publication readiness.
 *
 * This module is dependency-free and uses erasable TypeScript only, so it can be imported both by
 * the Next.js application (server components) and by the release check
 * (`apps/web/scripts/qa-publication.mjs`) under Node's type stripping.
 */

import type { Locale } from './locales';

export type PublicationStatus = 'VERIFIED' | 'MISSING' | 'INVALID';

export interface BilingualText { readonly en: string; readonly fr: string }

/** One operator-supplied value, mapped to exactly one environment variable. */
export interface PublicationVar {
  readonly key: string;
  readonly envVar: string;
  /** Short label used in the verified-details block and in release-check reasons. */
  readonly label: BilingualText;
}

/** A pending-list entry: the label shown while any of its values is not VERIFIED. */
export interface PublicationGroup {
  readonly key: string;
  /** Group label; byte-identical to the pending items the legal pages have always shown. */
  readonly label: BilingualText;
  readonly vars: readonly PublicationVar[];
  /** Essential groups block publication; optional groups stay visible but do not block. */
  readonly essential: boolean;
}

export interface PublicationVarState {
  readonly key: string;
  readonly envVar: string;
  readonly label: BilingualText;
  readonly status: PublicationStatus;
  /** The verified value; present only when status is VERIFIED. Never contains an INVALID value. */
  readonly value?: string;
}

export interface PublicationGroupState {
  readonly key: string;
  readonly label: BilingualText;
  readonly essential: boolean;
  readonly status: PublicationStatus;
  readonly vars: readonly PublicationVarState[];
}

export interface PublicationState {
  readonly contactEmail: PublicationVarState;
  readonly groups: readonly PublicationGroupState[];
  /** Every VERIFIED value across all groups, in registry order. */
  readonly verifiedVars: readonly PublicationVarState[];
  /** Groups that are not fully VERIFIED (still shown on the pages as pending). */
  readonly pendingGroups: readonly PublicationGroupState[];
  /** Pending groups whose absence blocks publication. */
  readonly blockingGroups: readonly PublicationGroupState[];
  /** True when the contact email is VERIFIED and no essential group is MISSING or INVALID. */
  readonly ready: boolean;
}

const EMAIL_LOCAL = 64;
const EMAIL_MAX = 254;
const TEXT_MAX = 400;

/** Strict public contact address: no spaces or control characters, one @, a dot-separated domain. */
export function isValidPublicEmail(value: string): boolean {
  if (value.length === 0 || value.length > EMAIL_MAX) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length === 0 || local.length > EMAIL_LOCAL) return false;
  if (!/^[A-Za-z0-9._%+-]+$/.test(local)) return false;
  // Domain labels must be dot-separated, can neither begin nor end with a hyphen, and are
  // DNS-length-bounded (63 per label).
  if (!domain.split('.').every(label => label.length > 0 && label.length <= 63)) return false;
  if (!/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(domain)) return false;
  return true;
}

/** Supplied text: trimmed; any control character or oversized value is rejected, never published. */
function suppliedText(raw: string | undefined): { status: PublicationStatus; value?: string } {
  const value = (raw ?? '').trim();
  if (value.length === 0) return { status: 'MISSING' };
  if (value.length > TEXT_MAX || /[\u0000-\u001F\u007F]/.test(value)) return { status: 'INVALID' };
  return { status: 'VERIFIED', value };
}

/**
 * The publication field registry. Group labels are the exact pending items the legal pages have
 * always displayed, plus the legal basis required by the privacy page. Optional groups (marked
 * "if applicable" on the pages) never block publication.
 */
export const PUBLICATION_GROUPS: readonly PublicationGroup[] = [
  {
    key: 'entity', essential: true,
    label: { en: 'Legal entity name and legal form', fr: 'Raison sociale et forme juridique de l’éditeur' },
    vars: [
      { key: 'entityName', envVar: 'QEYNOX_LEGAL_ENTITY_NAME', label: { en: 'Legal entity name', fr: 'Raison sociale' } },
      { key: 'entityForm', envVar: 'QEYNOX_LEGAL_ENTITY_FORM', label: { en: 'Legal form', fr: 'Forme juridique' } },
    ],
  },
  {
    key: 'office', essential: true,
    label: { en: 'Registered office address', fr: 'Adresse du siège social' },
    vars: [{ key: 'registeredOffice', envVar: 'QEYNOX_LEGAL_REGISTERED_OFFICE', label: { en: 'Registered office address', fr: 'Adresse du siège social' } }],
  },
  {
    key: 'registration', essential: true,
    label: { en: 'Registration number (trade and companies register)', fr: 'Numéro d’immatriculation (registre du commerce et des sociétés)' },
    vars: [{ key: 'registrationNumber', envVar: 'QEYNOX_LEGAL_REGISTRATION_NUMBER', label: { en: 'Registration number', fr: 'Numéro d’immatriculation' } }],
  },
  {
    key: 'vat', essential: false,
    label: { en: 'VAT number, if applicable', fr: 'Numéro de TVA intracommunautaire, le cas échéant' },
    vars: [{ key: 'vatNumber', envVar: 'QEYNOX_LEGAL_VAT_NUMBER', label: { en: 'VAT number', fr: 'Numéro de TVA intracommunautaire' } }],
  },
  {
    key: 'director', essential: true,
    label: { en: 'Publication director', fr: 'Directeur de la publication' },
    vars: [{ key: 'publicationDirector', envVar: 'QEYNOX_LEGAL_PUBLICATION_DIRECTOR', label: { en: 'Publication director', fr: 'Directeur de la publication' } }],
  },
  {
    key: 'hosting', essential: true,
    label: { en: 'Hosting provider: name, address and contact', fr: 'Hébergeur : nom, adresse et contact' },
    vars: [
      { key: 'hostingName', envVar: 'QEYNOX_HOSTING_PROVIDER_NAME', label: { en: 'Hosting provider name', fr: 'Nom de l’hébergeur' } },
      { key: 'hostingAddress', envVar: 'QEYNOX_HOSTING_PROVIDER_ADDRESS', label: { en: 'Hosting provider address', fr: 'Adresse de l’hébergeur' } },
      { key: 'hostingContact', envVar: 'QEYNOX_HOSTING_PROVIDER_CONTACT', label: { en: 'Hosting provider contact', fr: 'Contact de l’hébergeur' } },
    ],
  },
  {
    key: 'dpo', essential: false,
    label: { en: 'Data protection contact / DPO, if designated', fr: 'Contact protection des données / DPO, si désigné' },
    vars: [{ key: 'dpoContact', envVar: 'QEYNOX_LEGAL_DPO_CONTACT', label: { en: 'Data protection contact', fr: 'Contact protection des données' } }],
  },
  {
    key: 'jurisdiction', essential: true,
    label: { en: 'Competent jurisdiction and applicable law', fr: 'Juridiction compétente et droit applicable' },
    vars: [{ key: 'jurisdiction', envVar: 'QEYNOX_LEGAL_JURISDICTION', label: { en: 'Competent jurisdiction and applicable law', fr: 'Juridiction compétente et droit applicable' } }],
  },
  {
    key: 'retention', essential: true,
    label: { en: 'Data retention periods and international transfer safeguards', fr: 'Durées de conservation et garanties de transferts internationaux' },
    vars: [{ key: 'retentionTransfers', envVar: 'QEYNOX_LEGAL_RETENTION_TRANSFERS', label: { en: 'Retention periods and transfer safeguards', fr: 'Durées de conservation et garanties de transfert' } }],
  },
  {
    key: 'legalBasis', essential: true,
    label: { en: 'Legal basis for each processing purpose', fr: 'Base légale de chaque finalité de traitement' },
    vars: [{ key: 'legalBasis', envVar: 'QEYNOX_LEGAL_LEGAL_BASIS', label: { en: 'Legal basis for each processing purpose', fr: 'Base légale de chaque finalité de traitement' } }],
  },
  {
    key: 'cookieOwner', essential: false,
    label: { en: 'Cookie/storage configuration owner and consent tooling, if added later', fr: 'Responsable de la configuration cookies/stockage et outil de consentement, si ajouté ultérieurement' },
    vars: [{ key: 'cookieOwner', envVar: 'QEYNOX_LEGAL_COOKIE_OWNER', label: { en: 'Cookie configuration owner', fr: 'Responsable de la configuration cookies' } }],
  },
];

export const CONTACT_EMAIL_ENV = 'QEYNOX_CONTACT_EMAIL';
const CONTACT_EMAIL_LABEL: BilingualText = { en: 'Public contact address', fr: 'Adresse de contact publique' };

type PublicationEnv = Readonly<Record<string, string | undefined>>;

function varState(varDef: PublicationVar, env: PublicationEnv): PublicationVarState {
  const { status, value } = suppliedText(env[varDef.envVar]);
  return status === 'VERIFIED' ? { ...varDef, status, value } : { ...varDef, status };
}

function groupStatus(states: readonly PublicationVarState[]): PublicationStatus {
  if (states.every(s => s.status === 'VERIFIED')) return 'VERIFIED';
  if (states.some(s => s.status === 'INVALID')) return 'INVALID';
  return 'MISSING';
}

/**
 * Reads the publication state from the given environment (default: the server environment). Called
 * at request time by the public pages; the deployment env is the only source of values.
 */
export function publicationState(env: PublicationEnv = process.env): PublicationState {
  const email = suppliedText(env[CONTACT_EMAIL_ENV]);
  const contactEmail: PublicationVarState = email.status === 'VERIFIED' && !isValidPublicEmail(email.value ?? '')
    ? { key: 'contactEmail', envVar: CONTACT_EMAIL_ENV, label: CONTACT_EMAIL_LABEL, status: 'INVALID' }
    : email.status === 'VERIFIED'
      ? { key: 'contactEmail', envVar: CONTACT_EMAIL_ENV, label: CONTACT_EMAIL_LABEL, status: 'VERIFIED', value: email.value }
      : { key: 'contactEmail', envVar: CONTACT_EMAIL_ENV, label: CONTACT_EMAIL_LABEL, status: email.status };
  const groups = PUBLICATION_GROUPS.map(group => {
    const vars = group.vars.map(varDef => varState(varDef, env));
    return { key: group.key, label: group.label, essential: group.essential, status: groupStatus(vars), vars };
  });
  const verifiedVars = groups.flatMap(g => g.vars.filter(v => v.status === 'VERIFIED'));
  const pendingGroups = groups.filter(g => g.status !== 'VERIFIED');
  const blockingGroups = pendingGroups.filter(g => g.essential);
  return {
    contactEmail,
    groups,
    verifiedVars,
    pendingGroups,
    blockingGroups,
    ready: contactEmail.status === 'VERIFIED' && blockingGroups.length === 0,
  };
}

/** The pending items exactly as the legal pages display them, in registry order, for the locale. */
export function pendingLabels(state: PublicationState, lang: Locale): readonly string[] {
  return state.pendingGroups.map(group => group.label[lang]);
}

/** Release-check reasons: one line per blocking problem, naming the variable but never its value. */
export function publicationBlockers(state: PublicationState, siteUrl?: string): readonly string[] {
  const reasons: string[] = [];
  if (state.contactEmail.status === 'MISSING') reasons.push(CONTACT_EMAIL_ENV + ' is not set: no verified public contact address.');
  if (state.contactEmail.status === 'INVALID') reasons.push(CONTACT_EMAIL_ENV + ' is set but is not a valid public e-mail address; the value is never published.');
  for (const group of state.blockingGroups) {
    for (const varState of group.vars) {
      if (varState.status === 'MISSING') reasons.push(varState.envVar + ' is not set (required: ' + group.label.en + ').');
      if (varState.status === 'INVALID') reasons.push(varState.envVar + ' is set but invalid (control characters or length); the value is never published.');
    }
  }
  if (siteUrl !== undefined && !siteUrl.startsWith('https://')) reasons.push('The public site URL (' + siteUrl + ') is not https://.');
  return reasons;
}
