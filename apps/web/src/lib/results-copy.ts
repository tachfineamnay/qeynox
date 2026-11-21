import type { Locale } from './copy';

const en = {
  eyebrow: 'GLOBAL ATLAS LIBRARY',
  title: 'Results library',
  intro:
    'Search, filter, compare versions, export artefacts and manage time-bounded sharing across every recorded result in this workspace.',
  refresh: 'Refresh',
  openMission: 'Open mission',
  openInLibrary: 'Open in Atlas library (versions & sharing)',
  backToLibrary: 'Back to results library',
  startMission: 'Start a mission',
  browseServices: 'Browse services',

  // Summary metrics
  metricMatching: 'Matching versions',
  metricWorkspaceTotal: 'Workspace result versions',
  metricMissionsWithResults: 'Missions with results',
  metricFailedMissions: 'Failed missions',

  // Filters & search
  filtersTitle: 'Search and filters',
  searchLabel: 'Search workspace results',
  searchPlaceholder: 'Title, objective, mission, finding or citation provider…',
  missionLabel: 'Mission',
  allMissions: 'All missions',
  stateLabel: 'Result state',
  allStates: 'All result states',
  missionStatusLabel: 'Mission status',
  allMissionStatuses: 'All mission statuses',
  versionScopeLabel: 'Version scope',
  versionScopes: {
    ALL: 'All versions',
    LATEST: 'Latest version per mission',
    PREVIOUS: 'Previous / superseded versions',
  },
  versionNumberLabel: 'Exact version #',
  versionNumberPlaceholder: 'Any',
  dateFromLabel: 'Created from (UTC)',
  dateToLabel: 'Created to (UTC)',
  applyFilters: 'Apply filters',
  resetFilters: 'Reset filters',
  showingCount: 'Showing',
  ofTotal: 'of',
  matchingVersions: 'result version(s)',
  nextPage: 'Next page →',
  firstPage: '← First page',

  // Verification postures (always rendered with explicit text labels)
  postureLabel: 'Verification',
  posture: {
    VERIFIED_DELIVERABLE: 'Reviewed & evidence-supported',
    AWAITING_REVIEW: 'Evidence-ready · awaiting human review',
    PARTIALLY_VERIFIED: 'Partially verified · unresolved items remain',
    UNVERIFIED: 'Unverified · not established as conclusions',
  },
  postureNote: {
    VERIFIED_DELIVERABLE:
      'Human-reviewed deliverable with verifiable http(s) citations on every finding.',
    AWAITING_REVIEW:
      'All recorded findings have verifiable citations, but human review and delivery are still required.',
    PARTIALLY_VERIFIED:
      'Contains at least one evidence-supported finding alongside unresolved or unassessed claims. Do not treat unresolved items as conclusions.',
    UNVERIFIED:
      'Zero findings are verified yet. Treat all statements in this version as draft or unverified claims.',
  },

  // Card metadata & provenance
  latestBadge: 'Latest version',
  supersededBadge: 'Superseded by v',
  versionPrefix: 'Version v',
  ofVersionPrefix: 'of v',
  missionPrefix: 'Mission:',
  createdLabel: 'Created',
  updatedLabel: 'Last update',
  reviewedLabel: 'Reviewed',
  provenanceLabel: 'Provenance',
  verifiableSources: 'verifiable citation(s)',
  totalSources: 'total source(s)',
  noProvenanceRecorded: 'No source recorded on this version',
  providersLabel: 'Providers:',
  latestSourceRetrieved: 'Latest source retrieved',
  countsSummary: {
    verified: 'verified',
    unresolved: 'unresolved',
    awaiting: 'awaiting assessment',
    interpretation: 'AI interpretation',
  },
  storedExportsLabel: 'Stored exports:',
  noStoredExports: 'None stored yet',
  pendingExportsBadge: 'incomplete upload(s) (PENDING_UPLOAD)',
  activeSharesBadge: 'active share link(s)',
  openResult: 'Inspect Atlas result',
  comparePrevious: 'Compare with previous',
  jumpLatest: 'Open latest',

  // Empty, failed & unavailable states
  emptyWorkspaceTitle: 'No Atlas result has been recorded in this workspace yet',
  emptyWorkspaceBody:
    'Launch a mission from MyDash or request a configured business service pack to produce your first evidence-backed result.',
  emptyFilteredTitle: 'No result matched these filters',
  emptyFilteredBody:
    'No persisted result document in this workspace matched your current search or filter criteria. Clear or broaden your filters to view recorded versions.',
  failedMissionsTitle: 'Failed missions in this workspace',
  failedMissionsNote:
    'These missions stopped in FAILED state. QeyNox never fabricates a deliverable when execution fails; open the mission workspace to inspect blockers, revise the plan or retry.',
  failedNoDocuments: 'No result document produced before failure',
  failedPartialDocuments: 'earlier version(s) recorded before failure',
  failedOperationBanner:
    'Parent mission is currently in FAILED state. Inspect the mission timeline before relying on earlier result versions.',
  errorCodePrefix: 'Error code:',
  storageUnavailableNotice:
    'Private S3 object storage is not configured on this deployment (NOT_CONFIGURED). In-app Atlas inspection works normally, while artifact upload and signed download URLs remain unavailable until object storage is configured.',
  invalidQueryNotice:
    'Check your filter parameters (for example, start date must not be after end date, and pagination cursors must not be modified).',

  // Detail & version comparison
  versionHistoryTitle: 'Document version history',
  versionHistoryNote:
    'Revisions and reviews append immutable versions; earlier versions are preserved for auditability.',
  previousVersionBtn: '← Previous version',
  nextVersionBtn: 'Newer version →',
  jumpToLatestBtn: 'Jump to latest',
  currentViewingBadge: 'Viewing now',
  compareTitle: 'Version comparison',
  compareSubtitle: 'Deterministic diff derived from persisted ResultDocument versions.',
  compareWithLabel: 'Compare this version against',
  compareApply: 'Compare',
  noPriorVersion: 'This is the only recorded version for this mission so far.',
  statusTransitionLabel: 'Document state',
  unchanged: 'unchanged',
  deltaVerified: 'Evidence-supported delta',
  deltaUnresolved: 'Unresolved delta',
  deltaAwaiting: 'Awaiting assessment delta',
  deltaCitations: 'Citations delta',
  changedFindingsTitle: 'Findings whose verification status changed',
  addedFindingsTitle: 'Findings added in newer version',
  removedFindingsTitle: 'Findings removed in newer version',
  scopeAddedTitle: 'Scope items added',
  scopeRemovedTitle: 'Scope items removed',
  noFindingDiff: 'Finding statuses and statements are identical between these two versions.',

  // Exports & S3 artifacts
  exportsTitle: 'Exports & private S3 artefacts',
  exportsSubtitle:
    'PDF, HTML and canonical JSON exports use the exact same finding classifier as the Atlas reader.',
  exportBtn: 'Export & sign',
  exportBusy: 'Working…',
  exportSupersededNote:
    'Generating a new export requires the document to belong to the mission’s active plan revision. Existing stored artefacts below remain downloadable.',
  existingArtifactsTitle: 'Recorded artefacts for this version',
  noExistingArtifacts: 'No exported artefact has been stored for this document version yet.',
  artifactAvailable: 'AVAILABLE',
  artifactPending: 'PENDING_UPLOAD — upload incomplete',
  getSignedUrlBtn: 'Get signed download link (3 min)',
  openDownloadLink: 'Download signed artefact',
  sha256Label: 'SHA-256',
  reconcileBtn: 'Reconcile pending uploads',
  reconcileSuccess: 'Pending upload reconciliation completed.',

  // Controlled sharing
  shareTitle: 'Controlled external sharing',
  shareSubtitle:
    'Time-bounded, revocable read-only links backed by the canonical result document. Raw tokens are shown once and stored only as SHA-256 digests.',
  shareLockedNotDeliverable:
    'External sharing is locked until this document passes human review and is delivered (status DELIVERABLE). Unreviewed drafts and partial results cannot be shared outside the workspace.',
  shareLockedMemberRole:
    'Your workspace role is MEMBER. Only workspace owners and administrators (OWNER / ADMIN) can create, inspect or revoke external share links.',
  shareLabelField: 'Recipient or purpose label (optional)',
  shareLabelPlaceholder: 'Example: Board review — Q4 expansion',
  shareExpiryField: 'Link expiry',
  shareExpiryOptions: {
    '24': '24 hours',
    '72': '3 days (72 hours)',
    '168': '7 days',
    '720': '30 days (maximum)',
  },
  createShareBtn: 'Create expiring share link',
  creatingShare: 'Creating…',
  shareCreatedHeading: 'Share link created — copy now',
  shareCreatedNote:
    'For security, this capability URL is displayed only once. Anyone with the link can read the sanitized Atlas deliverable until it expires or you revoke it.',
  copyShareBtn: 'Copy link',
  copiedShareBtn: 'Copied',
  openSharedView: 'Preview shared page',
  existingSharesTitle: 'Recorded share links for this version',
  noSharesYet: 'No external share link has been created for this document version.',
  shareState: {
    ACTIVE: 'Active',
    EXPIRED: 'Expired',
    REVOKED: 'Revoked',
  },
  shareUntitled: 'Untitled share link',
  shareCreatedCol: 'Created',
  shareExpiresCol: 'Expires',
  shareAccessCol: 'Views',
  shareStatusCol: 'State',
  revokeShareBtn: 'Revoke immediately',
  revokingShare: 'Revoking…',
  shareRevokedConfirm: 'Share link revoked.',

  // Public shared result page
  sharedEyebrow: 'CONTROLLED SHARED RESULT · READ-ONLY',
  sharedBannerTitle: 'Shared QeyNox Atlas deliverable',
  sharedLabelPrefix: 'Reference:',
  sharedExpiresPrefix: 'Access expires:',
  sharedReadOnlyNote:
    'Read-only external view of a reviewed QeyNox ResultDocument. Internal workspace identifiers and reviewer account IDs are omitted.',
  sharedRevokedOrExpiredTitle: 'This shared result link has expired or been revoked',
  sharedRevokedOrExpiredBody:
    'The workspace administrator set an expiration time or revoked access to this link. Ask the sender for a new link if you still need access.',
  sharedNotFoundTitle: 'Shared result unavailable',
  sharedNotFoundBody:
    'No active deliverable result matched this link, or the link format is invalid.',
};

const fr: typeof en = {
  eyebrow: 'BIBLIOTHÈQUE GLOBALE ATLAS',
  title: 'Bibliothèque des résultats',
  intro:
    'Recherchez, filtrez, comparez les versions, exportez vos livrables et gérez le partage temporaire et révocable de tous les résultats enregistrés dans cet espace.',
  refresh: 'Actualiser',
  openMission: 'Ouvrir la mission',
  openInLibrary: 'Ouvrir dans la bibliothèque Atlas (versions et partage)',
  backToLibrary: 'Retour à la bibliothèque des résultats',
  startMission: 'Démarrer une mission',
  browseServices: 'Parcourir les services',

  // Summary metrics
  metricMatching: 'Versions correspondantes',
  metricWorkspaceTotal: 'Versions dans l’espace',
  metricMissionsWithResults: 'Missions avec résultats',
  metricFailedMissions: 'Missions en échec',

  // Filters & search
  filtersTitle: 'Recherche et filtres',
  searchLabel: 'Rechercher dans les résultats de l’espace',
  searchPlaceholder: 'Titre, objectif, mission, constat ou fournisseur de source…',
  missionLabel: 'Mission',
  allMissions: 'Toutes les missions',
  stateLabel: 'État du résultat',
  allStates: 'Tous les états de résultat',
  missionStatusLabel: 'État de la mission',
  allMissionStatuses: 'Tous les états de mission',
  versionScopeLabel: 'Portée des versions',
  versionScopes: {
    ALL: 'Toutes les versions',
    LATEST: 'Dernière version par mission',
    PREVIOUS: 'Versions précédentes / remplacées',
  },
  versionNumberLabel: 'N° de version exact',
  versionNumberPlaceholder: 'Toutes',
  dateFromLabel: 'Créé à partir du (UTC)',
  dateToLabel: 'Créé jusqu’au (UTC)',
  applyFilters: 'Appliquer les filtres',
  resetFilters: 'Réinitialiser',
  showingCount: 'Affichage de',
  ofTotal: 'sur',
  matchingVersions: 'version(s) de résultat',
  nextPage: 'Page suivante →',
  firstPage: '← Première page',

  // Verification postures
  postureLabel: 'Vérification',
  posture: {
    VERIFIED_DELIVERABLE: 'Revu et étayé par des preuves',
    AWAITING_REVIEW: 'Preuves prêtes · en attente de revue humaine',
    PARTIALLY_VERIFIED: 'Partiellement vérifié · éléments non résolus',
    UNVERIFIED: 'Non vérifié · aucune conclusion établie',
  },
  postureNote: {
    VERIFIED_DELIVERABLE:
      'Livrable revu par un humain avec citations http(s) vérifiables pour chaque constat.',
    AWAITING_REVIEW:
      'Tous les constats enregistrés disposent de citations vérifiables, mais la revue humaine et la livraison restent requises.',
    PARTIALLY_VERIFIED:
      'Contient au moins un constat étayé par des preuves ainsi que des éléments non résolus ou en attente d’évaluation.',
    UNVERIFIED:
      'Aucun constat n’est encore vérifié. Traitez l’ensemble de cette version comme un brouillon ou des affirmations non vérifiées.',
  },

  // Card metadata & provenance
  latestBadge: 'Dernière version',
  supersededBadge: 'Remplacée par v',
  versionPrefix: 'Version v',
  ofVersionPrefix: 'sur v',
  missionPrefix: 'Mission :',
  createdLabel: 'Créé le',
  updatedLabel: 'Dernière mise à jour',
  reviewedLabel: 'Revu le',
  provenanceLabel: 'Provenance',
  verifiableSources: 'citation(s) vérifiable(s)',
  totalSources: 'source(s) au total',
  noProvenanceRecorded: 'Aucune source enregistrée sur cette version',
  providersLabel: 'Fournisseurs :',
  latestSourceRetrieved: 'Dernière collecte de source',
  countsSummary: {
    verified: 'étayé(s)',
    unresolved: 'non résolu(s)',
    awaiting: 'en attente',
    interpretation: 'interprétation IA',
  },
  storedExportsLabel: 'Exports stockés :',
  noStoredExports: 'Aucun export stocké',
  pendingExportsBadge: 'envoi(s) incomplet(s) (PENDING_UPLOAD)',
  activeSharesBadge: 'lien(s) de partage actif(s)',
  openResult: 'Consulter le résultat Atlas',
  comparePrevious: 'Comparer à la version précédente',
  jumpLatest: 'Ouvrir la dernière version',

  // Empty, failed & unavailable states
  emptyWorkspaceTitle: 'Aucun résultat Atlas n’est encore enregistré dans cet espace',
  emptyWorkspaceBody:
    'Lancez une mission depuis MyDash ou commandez un service métier configuré pour produire votre premier livrable étayé par des preuves.',
  emptyFilteredTitle: 'Aucun résultat ne correspond à ces filtres',
  emptyFilteredBody:
    'Aucun document de résultat enregistré dans cet espace ne correspond à vos critères actuels. Effacez ou élargissez vos filtres.',
  failedMissionsTitle: 'Missions en échec dans cet espace',
  failedMissionsNote:
    'Ces missions se sont arrêtées à l’état FAILED. QeyNox ne fabrique jamais de livrable lorsqu’une exécution échoue ; ouvrez la mission pour inspecter les blocages, réviser le plan ou relancer.',
  failedNoDocuments: 'Aucun document produit avant l’échec',
  failedPartialDocuments: 'version(s) antérieure(s) enregistrée(s) avant l’échec',
  failedOperationBanner:
    'La mission parente est actuellement en échec (FAILED). Consultez l’espace mission avant de vous appuyer sur une version antérieure.',
  errorCodePrefix: 'Code d’erreur :',
  storageUnavailableNotice:
    'Le stockage objet privé S3 n’est pas configuré sur ce déploiement (NOT_CONFIGURED). La lecture Atlas fonctionne normalement, mais le téléversement d’exports et les liens signés restent indisponibles.',
  invalidQueryNotice:
    'Vérifiez vos paramètres de filtre (la date de début ne doit pas dépasser la date de fin et le curseur de pagination ne doit pas être altéré).',

  // Detail & version comparison
  versionHistoryTitle: 'Historique des versions du document',
  versionHistoryNote:
    'Les révisions et validations ajoutent des versions immuables ; les versions précédentes restent conservées pour l’audit.',
  previousVersionBtn: '← Version précédente',
  nextVersionBtn: 'Version suivante →',
  jumpToLatestBtn: 'Aller à la dernière version',
  currentViewingBadge: 'Version affichée',
  compareTitle: 'Comparaison de versions',
  compareSubtitle: 'Écart déterministe calculé à partir des versions ResultDocument persistées.',
  compareWithLabel: 'Comparer cette version avec',
  compareApply: 'Comparer',
  noPriorVersion: 'Il s’agit de la seule version enregistrée pour cette mission jusqu’ici.',
  statusTransitionLabel: 'État du document',
  unchanged: 'inchangé',
  deltaVerified: 'Écart constats étayés',
  deltaUnresolved: 'Écart non résolus',
  deltaAwaiting: 'Écart en attente',
  deltaCitations: 'Écart citations',
  changedFindingsTitle: 'Constats dont le statut de vérification a évolué',
  addedFindingsTitle: 'Constats ajoutés dans la version récente',
  removedFindingsTitle: 'Constats retirés dans la version récente',
  scopeAddedTitle: 'Éléments de périmètre ajoutés',
  scopeRemovedTitle: 'Éléments de périmètre retirés',
  noFindingDiff: 'Les constats et leurs statuts sont identiques entre ces deux versions.',

  // Exports & S3 artifacts
  exportsTitle: 'Exports et artefacts S3 privés',
  exportsSubtitle:
    'Les exports PDF, HTML et JSON canonique utilisent exactement le même classifieur de constats que le lecteur Atlas.',
  exportBtn: 'Exporter et signer',
  exportBusy: 'Traitement…',
  exportSupersededNote:
    'La génération d’un nouvel export exige que le document appartienne à la révision active du plan de mission. Les artefacts déjà stockés ci-dessous restent téléchargeables.',
  existingArtifactsTitle: 'Artefacts enregistrés pour cette version',
  noExistingArtifacts: 'Aucun artefact exporté n’a encore été stocké pour cette version.',
  artifactAvailable: 'DISPONIBLE',
  artifactPending: 'PENDING_UPLOAD — envoi incomplet',
  getSignedUrlBtn: 'Obtenir un lien signé (3 min)',
  openDownloadLink: 'Télécharger l’artefact signé',
  sha256Label: 'SHA-256',
  reconcileBtn: 'Réconcilier les envois en attente',
  reconcileSuccess: 'Réconciliation des envois en attente effectuée.',

  // Controlled sharing
  shareTitle: 'Partage externe contrôlé',
  shareSubtitle:
    'Liens en lecture seule, limités dans le temps et révocables à tout moment. Le jeton brut n’est affiché qu’une seule fois et seul son condensat SHA-256 est stocké.',
  shareLockedNotDeliverable:
    'Le partage externe est verrouillé tant que ce document n’a pas été revu par un humain et livré (statut DELIVERABLE). Les brouillons et résultats partiels ne peuvent pas être partagés hors de l’espace.',
  shareLockedMemberRole:
    'Votre rôle dans cet espace est MEMBER. Seuls les propriétaires et administrateurs (OWNER / ADMIN) peuvent créer, consulter ou révoquer des liens de partage externes.',
  shareLabelField: 'Destinataire ou objet du partage (facultatif)',
  shareLabelPlaceholder: 'Exemple : Revue comité — expansion T4',
  shareExpiryField: 'Expiration du lien',
  shareExpiryOptions: {
    '24': '24 heures',
    '72': '3 jours (72 heures)',
    '168': '7 jours',
    '720': '30 jours (maximum)',
  },
  createShareBtn: 'Créer un lien temporaire',
  creatingShare: 'Création…',
  shareCreatedHeading: 'Lien de partage créé — copiez-le maintenant',
  shareCreatedNote:
    'Par sécurité, cette URL n’est affichée qu’une seule fois. Toute personne disposant de ce lien peut consulter le livrable Atlas expurgé jusqu’à son expiration ou sa révocation.',
  copyShareBtn: 'Copier le lien',
  copiedShareBtn: 'Copié',
  openSharedView: 'Prévisualiser la page partagée',
  existingSharesTitle: 'Liens de partage enregistrés pour cette version',
  noSharesYet: 'Aucun lien de partage externe n’a été créé pour cette version.',
  shareState: {
    ACTIVE: 'Actif',
    EXPIRED: 'Expiré',
    REVOKED: 'Révoqué',
  },
  shareUntitled: 'Lien sans libellé',
  shareCreatedCol: 'Créé le',
  shareExpiresCol: 'Expire le',
  shareAccessCol: 'Consultations',
  shareStatusCol: 'État',
  revokeShareBtn: 'Révoquer immédiatement',
  revokingShare: 'Révocation…',
  shareRevokedConfirm: 'Lien de partage révoqué.',

  // Public shared result page
  sharedEyebrow: 'RÉSULTAT PARTAGÉ CONTRÔLÉ · LECTURE SEULE',
  sharedBannerTitle: 'Livrable Atlas QeyNox partagé',
  sharedLabelPrefix: 'Référence :',
  sharedExpiresPrefix: 'Expiration de l’accès :',
  sharedReadOnlyNote:
    'Vue externe en lecture seule d’un ResultDocument QeyNox revu et livré. Les identifiants internes d’espace et de compte validateur sont omis.',
  sharedRevokedOrExpiredTitle: 'Ce lien de partage a expiré ou a été révoqué',
  sharedRevokedOrExpiredBody:
    'L’administrateur de l’espace a fixé une échéance ou révoqué l’accès à ce lien. Demandez un nouveau lien à l’expéditeur si nécessaire.',
  sharedNotFoundTitle: 'Résultat partagé indisponible',
  sharedNotFoundBody:
    'Aucun résultat livré actif ne correspond à ce lien, ou le format du lien est invalide.',
};

export type ResultsCopy = typeof en;
export const resultsCopy: Record<Locale, ResultsCopy> = { en, fr };
