import type { Locale } from './copy';

/**
 * MISSION A21.04 — EN/FR copy for the free-beta customer journey. Components never hardcode copy:
 * every visible string of the beta offer summary, the account card and the state notices lives here.
 */
type StateCopy = { title: string; body: string };

export interface BetaCopy {
  eyebrow: string;
  headline: string;
  headlineDisabled: string;
  cardTitle: string;
  listPrice: string;
  listPriceWaivedSr: string;
  waiver: string;
  waiverNotApplied: string;
  dueToday: string;
  noListPrice: string;
  freeOfferNote: string;
  remaining: string;
  remainingValue: (remaining: number, quota: number) => string;
  running: string;
  runningValue: (active: number, limit: number) => string;
  providerBudget: string;
  expires: string;
  invitationExpires: string;
  status: string;
  accountStatus: Record<'NOT_ENROLLED' | 'INVITED' | 'ACTIVE' | 'EXPIRED' | 'REVOKED', string>;
  runtime: string;
  runtimeState: Record<'CONFIGURED' | 'OPERATIONAL' | 'BLOCKED' | 'UNVERIFIED', string>;
  states: Record<string, StateCopy>;
  quotaBudget: StateCopy;
  unavailable: (code: string) => StateCopy;
  frozenNote: string;
  launchNote: string;
  acceptNote: string;
  paymentReplaced: string;
  serverChecks: string;
  activateLabel: string;
  activateHint: string;
  activateButton: string;
  activateBusy: string;
  activateOk: string;
  activateErrors: Record<string, string>;
  activateAskAdmin: string;
  catalogueBadge: string;
}

const en: BetaCopy = {
  eyebrow: 'Free beta',
  headline: 'Free beta — no card required',
  headlineDisabled: 'Payments disabled — no card required',
  cardTitle: 'Your free beta access',
  listPrice: 'List price',
  listPriceWaivedSr: 'List price, waived by the free beta:',
  waiver: 'Beta waiver (100%)',
  waiverNotApplied: 'The 100% beta waiver applies only while this workspace’s beta access is active.',
  dueToday: 'Amount due today',
  noListPrice: 'No list price',
  freeOfferNote: 'This service is published free of charge; no waiver is needed.',
  remaining: 'Beta missions remaining',
  remainingValue: (remaining, quota) => remaining + ' of ' + quota,
  running: 'Missions running',
  runningValue: (active, limit) => active + ' of ' + limit + ' at a time',
  providerBudget: 'Provider budget remaining',
  expires: 'Beta access expires',
  invitationExpires: 'Invitation expires',
  status: 'Account status',
  accountStatus: { NOT_ENROLLED: 'Not enrolled', INVITED: 'Invited — awaiting activation', ACTIVE: 'Active', EXPIRED: 'Expired', REVOKED: 'Revoked' },
  runtime: 'Mission runtime',
  runtimeState: { OPERATIONAL: 'Operational', CONFIGURED: 'Configured, not verified', UNVERIFIED: 'Not verified', BLOCKED: 'Not operational' },
  states: {
    ACTIVE: { title: 'Free beta active', body: 'This workspace can launch missions under the free beta. Nothing is charged and no card is requested.' },
    NOT_CONFIGURED: { title: 'Free beta not configured', body: 'This deployment is not running the free beta. Payments are disabled, so no card is requested and nothing is charged — but priced services cannot be launched until the Qeynox team enables the free beta.' },
    NOT_ENROLLED: { title: 'Not enrolled in the free beta', body: 'Beta access is by invitation only and cannot be self-activated. Ask the Qeynox team for an invitation for this workspace.' },
    INVITATION_PENDING: { title: 'Invitation awaiting activation', body: 'A workspace owner or admin must activate the invitation with the token sent by the Qeynox team before missions can be launched.' },
    EXPIRED: { title: 'Free beta expired', body: 'The beta access for this workspace has ended, so new missions cannot be launched. Existing results stay available. Contact the Qeynox team to discuss an extension.' },
    REVOKED: { title: 'Free beta access revoked', body: 'The Qeynox team revoked the beta access for this workspace, so new missions cannot be launched. Existing results stay available.' },
    QUOTA_EXHAUSTED: { title: 'Beta mission allowance used up', body: 'Every beta mission included in this workspace’s allowance has been used, so new missions cannot be launched. Existing results stay available.' },
    CONCURRENT_LIMIT_REACHED: { title: 'Concurrent mission limit reached', body: 'The beta allows a limited number of missions to run at the same time. Launch the next one when a running mission finishes.' },
    RUNTIME_UNAVAILABLE: { title: 'Mission runtime unavailable', body: 'Your beta access is active, but the mission runtime is not operational on this deployment right now, so missions cannot be launched. Nothing is charged.' },
  },
  quotaBudget: { title: 'Beta provider budget used up', body: 'The provider budget included in this workspace’s beta access is used up: missions cannot call providers, so new missions cannot run. Existing results stay available.' },
  unavailable: code => ({ title: 'Beta status unavailable (' + code + ')', body: 'The free-beta status could not be read, so nothing is assumed. No card is requested; every launch is still checked by the server.' }),
  frozenNote: 'Payments are disabled during the beta: no card or payment method is collected and nothing is charged.',
  launchNote: 'Launching uses one mission of your beta allowance. The server re-checks your beta access at launch.',
  acceptNote: 'Accepting records the quote at its list price; the free beta covers it in full, so nothing is due.',
  paymentReplaced: 'No payment step: this order is handled under the free beta.',
  serverChecks: 'Displayed from the server’s beta record; the server re-checks access at every launch.',
  activateLabel: 'Invitation token',
  activateHint: 'Paste the 43-character token sent to you by the Qeynox team. It can be used once.',
  activateButton: 'Activate beta access',
  activateBusy: 'Activating…',
  activateOk: 'Beta access activated.',
  activateErrors: {
    INVALID_INPUT: 'The token format is invalid (43 characters, letters, digits, - and _).',
    DENIED: 'Only a workspace owner or admin can activate the invitation.',
    INVALID_STATE: 'This invitation can no longer be activated (already used, expired or revoked).',
    NOT_FOUND: 'This invitation token is invalid, already used or expired.',
    CONFLICT: 'The beta access changed meanwhile. Refresh the page.',
    SESSION_REQUIRED: 'Your session has expired. Sign in again.',
  },
  activateAskAdmin: 'Ask a workspace owner or admin to activate the invitation.',
  catalogueBadge: 'Free beta · nothing due today',
};

const fr: BetaCopy = {
  eyebrow: 'Bêta gratuite',
  headline: 'Bêta gratuite — aucune carte requise',
  headlineDisabled: 'Paiements désactivés — aucune carte requise',
  cardTitle: 'Votre accès bêta gratuit',
  listPrice: 'Prix catalogue',
  listPriceWaivedSr: 'Prix catalogue, annulé par la bêta gratuite :',
  waiver: 'Remise bêta (100 %)',
  waiverNotApplied: 'La remise bêta de 100 % ne s’applique que tant que l’accès bêta de cet espace est actif.',
  dueToday: 'Montant dû aujourd’hui',
  noListPrice: 'Aucun prix catalogue',
  freeOfferNote: 'Ce service est publié gratuitement ; aucune remise n’est nécessaire.',
  remaining: 'Missions bêta restantes',
  remainingValue: (remaining, quota) => remaining + ' sur ' + quota,
  running: 'Missions en cours',
  runningValue: (active, limit) => active + ' sur ' + limit + ' simultanément',
  providerBudget: 'Budget fournisseurs restant',
  expires: 'Fin de l’accès bêta',
  invitationExpires: 'Expiration de l’invitation',
  status: 'Statut du compte',
  accountStatus: { NOT_ENROLLED: 'Non inscrit', INVITED: 'Invité — activation en attente', ACTIVE: 'Actif', EXPIRED: 'Expiré', REVOKED: 'Révoqué' },
  runtime: 'Moteur d’exécution',
  runtimeState: { OPERATIONAL: 'Opérationnel', CONFIGURED: 'Configuré, non vérifié', UNVERIFIED: 'Non vérifié', BLOCKED: 'Non opérationnel' },
  states: {
    ACTIVE: { title: 'Bêta gratuite active', body: 'Cet espace peut lancer des missions dans le cadre de la bêta gratuite. Rien n’est facturé et aucune carte n’est demandée.' },
    NOT_CONFIGURED: { title: 'Bêta gratuite non configurée', body: 'Ce déploiement n’exécute pas la bêta gratuite. Les paiements sont désactivés : aucune carte n’est demandée et rien n’est facturé — mais les services payants ne peuvent pas être lancés tant que l’équipe Qeynox n’a pas activé la bêta gratuite.' },
    NOT_ENROLLED: { title: 'Non inscrit à la bêta gratuite', body: 'L’accès bêta se fait uniquement sur invitation et ne peut pas être auto-activé. Demandez une invitation pour cet espace à l’équipe Qeynox.' },
    INVITATION_PENDING: { title: 'Invitation en attente d’activation', body: 'Un propriétaire ou un administrateur de l’espace doit activer l’invitation avec le jeton envoyé par l’équipe Qeynox avant tout lancement de mission.' },
    EXPIRED: { title: 'Bêta gratuite expirée', body: 'L’accès bêta de cet espace est terminé : aucune nouvelle mission ne peut être lancée. Les résultats existants restent disponibles. Contactez l’équipe Qeynox pour discuter d’une prolongation.' },
    REVOKED: { title: 'Accès bêta gratuit révoqué', body: 'L’équipe Qeynox a révoqué l’accès bêta de cet espace : aucune nouvelle mission ne peut être lancée. Les résultats existants restent disponibles.' },
    QUOTA_EXHAUSTED: { title: 'Quota de missions bêta épuisé', body: 'Toutes les missions bêta incluses dans le quota de cet espace ont été utilisées : aucune nouvelle mission ne peut être lancée. Les résultats existants restent disponibles.' },
    CONCURRENT_LIMIT_REACHED: { title: 'Limite de missions simultanées atteinte', body: 'La bêta limite le nombre de missions exécutées en même temps. Lancez la suivante lorsqu’une mission en cours est terminée.' },
    RUNTIME_UNAVAILABLE: { title: 'Moteur d’exécution indisponible', body: 'Votre accès bêta est actif, mais le moteur d’exécution des missions n’est pas opérationnel sur ce déploiement pour le moment : aucune mission ne peut être lancée. Rien n’est facturé.' },
  },
  quotaBudget: { title: 'Budget fournisseurs bêta épuisé', body: 'Le budget fournisseurs inclus dans l’accès bêta de cet espace est épuisé : les missions ne peuvent plus appeler de fournisseurs, donc aucune nouvelle mission ne peut s’exécuter. Les résultats existants restent disponibles.' },
  unavailable: code => ({ title: 'Statut bêta indisponible (' + code + ')', body: 'Le statut de la bêta gratuite n’a pas pu être lu : rien n’est supposé. Aucune carte n’est demandée ; chaque lancement reste vérifié par le serveur.' }),
  frozenNote: 'Les paiements sont désactivés pendant la bêta : aucune carte ni moyen de paiement n’est collecté et rien n’est facturé.',
  launchNote: 'Le lancement utilise une mission de votre quota bêta. Le serveur revérifie votre accès bêta au lancement.',
  acceptNote: 'L’acceptation enregistre le devis à son prix catalogue ; la bêta gratuite le couvre entièrement, rien n’est dû.',
  paymentReplaced: 'Aucune étape de paiement : cette commande est traitée dans le cadre de la bêta gratuite.',
  serverChecks: 'Affiché d’après l’enregistrement bêta du serveur ; le serveur revérifie l’accès à chaque lancement.',
  activateLabel: 'Jeton d’invitation',
  activateHint: 'Collez le jeton de 43 caractères envoyé par l’équipe Qeynox. Il n’est utilisable qu’une fois.',
  activateButton: 'Activer l’accès bêta',
  activateBusy: 'Activation…',
  activateOk: 'Accès bêta activé.',
  activateErrors: {
    INVALID_INPUT: 'Le format du jeton est invalide (43 caractères : lettres, chiffres, - et _).',
    DENIED: 'Seul un propriétaire ou un administrateur de l’espace peut activer l’invitation.',
    INVALID_STATE: 'Cette invitation ne peut plus être activée (déjà utilisée, expirée ou révoquée).',
    NOT_FOUND: 'Ce jeton d’invitation est invalide, déjà utilisé ou expiré.',
    CONFLICT: 'L’accès bêta a changé entre-temps. Actualisez la page.',
    SESSION_REQUIRED: 'Votre session a expiré. Reconnectez-vous.',
  },
  activateAskAdmin: 'Demandez à un propriétaire ou un administrateur de l’espace d’activer l’invitation.',
  catalogueBadge: 'Bêta gratuite · rien à payer aujourd’hui',
};

export function betaCopy(lang: Locale): BetaCopy {
  return lang === 'fr' ? fr : en;
}
