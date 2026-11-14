import type { Locale } from './copy';

export interface LegalSection { readonly heading: string; readonly paragraphs: readonly string[] }
export interface LegalPageCopy {
  readonly title: string; readonly description: string; readonly intro: string;
  readonly sections: readonly LegalSection[]; readonly requiresPlaceholders: boolean;
}
export interface StepCopy { readonly title: string; readonly body: string }
export interface ValueCopy { readonly title: string; readonly body: string }

export interface SiteCopy {
  readonly nav: { readonly home: string; readonly how: string; readonly manifesto: string; readonly contact: string; readonly signin: string; readonly enter: string };
  readonly brandCaption: string;
  readonly language: string;
  readonly footer: { readonly tagline: string; readonly legalTitle: string; readonly pending: string };
  readonly home: {
    readonly title: string; readonly description: string; readonly eyebrow: string; readonly h1: string; readonly lead: string;
    readonly primary: string; readonly secondary: string;
    readonly valuesTitle: string; readonly values: readonly ValueCopy[];
    readonly stepsTitle: string; readonly steps: readonly StepCopy[];
    readonly evidenceTitle: string; readonly evidenceIntro: string; readonly evidence: readonly string[];
    readonly limitsTitle: string; readonly limits: string;
    readonly manifestoTitle: string; readonly manifestoBody: string; readonly manifestoLink: string; readonly ctaTitle: string;
  };
  readonly how: {
    readonly title: string; readonly description: string; readonly h1: string; readonly lead: string;
    readonly stepsTitle: string; readonly steps: readonly StepCopy[];
    readonly doesTitle: string; readonly does: readonly string[];
    readonly doesNotTitle: string; readonly doesNot: readonly string[];
    readonly capabilitiesTitle: string; readonly capabilities: string;
  };
  readonly manifesto: {
    readonly title: string; readonly description: string; readonly h1: string; readonly lead: string;
    readonly paragraphs: readonly string[]; readonly principlesTitle: string; readonly principles: readonly ValueCopy[];
  };
  readonly contact: {
    readonly title: string; readonly description: string; readonly h1: string; readonly lead: string;
    readonly supportTitle: string; readonly supportBody: string;
    readonly publicTitle: string; readonly publicBody: string; readonly publicMissing: string;
    readonly legalPendingTitle: string; readonly legalPendingBody: string;
  };
  readonly legal: { readonly notice: LegalPageCopy; readonly privacy: LegalPageCopy; readonly terms: LegalPageCopy; readonly cookies: LegalPageCopy };
  readonly pending: { readonly title: string; readonly intro: string };
}

export const legalPlaceholders: Readonly<Record<Locale, readonly string[]>> = {
  en: [
    'Legal entity name and legal form',
    'Registered office address',
    'Registration number (trade and companies register)',
    'VAT number, if applicable',
    'Publication director',
    'Hosting provider: name, address and contact',
    'Data protection contact / DPO, if designated',
    'Competent jurisdiction and applicable law',
    'Data retention periods and international transfer safeguards',
    'Cookie/storage configuration owner and consent tooling, if added later',
  ],
  fr: [
    'Raison sociale et forme juridique de l’éditeur',
    'Adresse du siège social',
    'Numéro d’immatriculation (registre du commerce et des sociétés)',
    'Numéro de TVA intracommunautaire, le cas échéant',
    'Directeur de la publication',
    'Hébergeur : nom, adresse et contact',
    'Contact protection des données / DPO, si désigné',
    'Juridiction compétente et droit applicable',
    'Durées de conservation et garanties de transferts internationaux',
    'Responsable de la configuration cookies/stockage et outil de consentement, si ajouté ultérieurement',
  ],
};

const en: SiteCopy = {
  nav: { home: 'Home', how: 'How it works', manifesto: 'Manifesto', contact: 'Contact', signin: 'Sign in', enter: 'Open MyDash' },
  brandCaption: 'Results as a Service',
  language: 'Language',
  footer: {
    tagline: 'QeyNox turns a stated business objective into governed work and an evidence-backed result. No promise of business or financial success.',
    legalTitle: 'Legal',
    pending: 'Legal data to be completed before publication.',
  },
  home: {
    title: 'QeyNox — Business intelligence, evidenced results',
    description: 'QeyNox is a Results-as-a-Service platform: state a business objective, review the governed plan, and receive a concrete result with its sources, limits and next action.',
    eyebrow: 'Results as a Service',
    h1: 'A useful business result, not agent theatre.',
    lead: 'State the outcome you need. QeyNox mobilises available, authorised business capabilities, does the work it can verify, and delivers a concrete result you can inspect and use — with sources, limits and your approval at consequential steps.',
    primary: 'Open MyDash',
    secondary: 'See how it works',
    valuesTitle: 'What QeyNox is built for',
    values: [
      { title: 'Objectives, not prompts', body: 'A mission starts from a business objective and the decision behind it. The interface stays focused on the outcome and the next useful action.' },
      { title: 'Governed work', body: 'Tools are mediated, permissions fail closed, and consequential actions require human approval. Unconfigured capabilities remain inactive rather than being simulated.' },
      { title: 'Evidence, dated and inspectable', body: 'Sources are recorded with dates and limitations. A result is a deliverable, not a claim of guaranteed growth or profit.' },
    ],
    stepsTitle: 'From objective to usable result',
    steps: [
      { title: 'Describe the objective', body: 'Explain what you need to understand, decide or deliver. Add the constraints that matter, including access and budget considerations where relevant.' },
      { title: 'Review and approve', body: 'Examine the proposed scope and any approval request before consequential execution. You remain the decision-maker.' },
      { title: 'Inspect the evidenced result', body: 'Read the deliverable, its sources, its limitations and the suggested next action. Return later to continue or revise the work.' },
    ],
    evidenceTitle: 'What you can verify',
    evidenceIntro: 'QeyNox is designed so that trust comes from inspectable evidence rather than polished claims.',
    evidence: [
      'Recorded sources with retrieval dates and stated limitations',
      'Explicit review status for partial, unverified or draft findings',
      'A history of operations and revisions in your workspace',
      'Approval gates before consequential external actions',
    ],
    limitsTitle: 'Clear limits',
    limits: 'QeyNox does not promise financial or business success, and it is not a CRM, a general productivity operating system or an autonomous decision-maker. Available capabilities depend on what is configured and authorised for your workspace; anything unavailable is shown as unavailable.',
    manifestoTitle: 'Results over agent theatre',
    manifestoBody: 'Business expertise should be accessible without prior technical experience. QeyNox is multilingual by design, transparent about costs and limitations, and keeps humans in control of consequential actions.',
    manifestoLink: 'Read the manifesto',
    ctaTitle: 'Start with a clear objective',
  },
  how: {
    title: 'How QeyNox works — objective, governed work, evidenced result',
    description: 'The QeyNox workflow: state a business objective, review scope and approvals, then receive a concrete deliverable with sources, limitations and a next action.',
    h1: 'How QeyNox works',
    lead: 'A mission is a governed chain from a stated objective to a deliverable you can inspect. The interface exposes the parts that matter: what will be done, what it needs, what it found, and what remains uncertain.',
    stepsTitle: 'The mission path',
    steps: [
      { title: '1. Objective and constraints', body: 'You describe the business outcome and the constraints that matter. QeyNox records it as a mission goal rather than an open-ended chat.' },
      { title: '2. Plan, access and approval', body: 'Before consequential work, you can review the scope, access requirements and approval request. Tools are mediated by the platform and permissions fail closed.' },
      { title: '3. Execution and evidence', body: 'Configured capabilities perform the work they are authorised to perform. Sources, limitations and result status are recorded so the deliverable can be reviewed rather than merely believed.' },
      { title: '4. Result and next action', body: 'You receive a concrete result, inspect its evidence and decide what to do next. Work can be continued, revised or interrupted within platform limits.' },
    ],
    doesTitle: 'What QeyNox does',
    does: [
      'Turns a stated business objective into recorded, governed work',
      'Uses only configured and authorised capabilities and tools',
      'Delivers deliverables with recorded sources and stated limitations',
      'Keeps humans in control of approvals and consequential actions',
    ],
    doesNotTitle: 'What QeyNox does not do',
    doesNot: [
      'Promise financial, commercial or professional success',
      'Run an autonomous swarm or replace your judgement',
      'Simulate unavailable capabilities or fabricate evidence',
      'Display prices, testimonials or performance claims that are not verified',
    ],
    capabilitiesTitle: 'Capability availability is honest',
    capabilities: 'QeyNox exposes only the business capabilities that are configured and authorised for a workspace. If a capability is not available, the product must say so instead of producing a fictional result. Exact availability depends on the workspace configuration and the platform deployment.',
  },
  manifesto: {
    title: 'The QeyNox manifesto — results over agent theatre',
    description: 'The QeyNox manifesto: business intelligence for everyday use, accessible expertise, governed tools, dated sources and human control over consequential actions.',
    h1: 'Business intelligence for everyday use',
    lead: 'QeyNox puts an AI-powered business expert team within reach — a service, not a promise of profit.',
    paragraphs: [
      'The user states an objective; QeyNox mobilises available business capabilities and authorised external tools, does the research and verified work it can, then delivers a concrete, usable result.',
      'QeyNox is a service, not a promise of profit. It expands business intelligence and capabilities, not a universal personal productivity operating system. Users can return every day, launch several operations, suspend or revise work, and carry their consented context forward.',
      'Business expertise should be accessible regardless of prior experience. QeyNox is globally oriented, multilingual by design and transparent about costs, limitations and evidence.',
      'RaaS: results over agent theatre. Tools are governed, sources are dated, and humans remain decision-makers for consequential actions.',
    ],
    principlesTitle: 'Operating principles',
    principles: [
      { title: 'Results first', body: 'Outcome, next action and source-backed deliverables dominate the experience; technical agents stay behind the product.' },
      { title: 'Trust by evidence', body: 'Provenance, review status, approvals and uncertainty are inspectable rather than hidden behind confident copy.' },
      { title: 'Progressive disclosure', body: 'Show what matters first; reveal workflows, budgets and evidence depth when requested.' },
      { title: 'Quiet precision', body: 'Disciplined interfaces, clear limits and no engagement mechanics that substitute for useful work.' },
    ],
  },
  contact: {
    title: 'Contact QeyNox',
    description: 'How to contact QeyNox: authenticated workspace support, and the public contact channel that must be completed before publication.',
    h1: 'Contact',
    lead: 'Choose the appropriate channel for your question. We do not publish a contact address, phone number or legal identity that has not been verified.',
    supportTitle: 'Existing customers and workspace members',
    supportBody: 'Sign in and use the Support entry in MyDash. Conversations are handled in the platform support process, with the same account and workspace isolation as your QeyNox data.',
    publicTitle: 'Public or prospective enquiries',
    publicBody: 'A public contact address will be published here once the legal and operational details are confirmed. The site intentionally does not invent an email address, form endpoint or response-time commitment.',
    publicMissing: 'Public contact address: to be completed before publication.',
    legalPendingTitle: 'Legal information to complete',
    legalPendingBody: 'The legal pages already state the actual data and cookie usages implemented in the product. Identity, hosting, jurisdiction and retention fields remain marked for completion before publication.',
  },
  legal: {
    notice: {
      title: 'Legal notice — QeyNox',
      description: 'QeyNox legal notice. Legal entity, hosting and jurisdiction details are explicitly flagged as to be completed before publication.',
      intro: 'This page identifies the publisher and host of the QeyNox website. Fields that have not been verified are explicitly marked and must be completed before publication.',
      requiresPlaceholders: true,
      sections: [
        { heading: 'Publisher', paragraphs: ['The QeyNox service is operated by the legal entity identified in the completed legal details below. The entity name, legal form and registered office have not yet been published because they have not been verified in this repository.'] },
        { heading: 'Publication director', paragraphs: ['The publication director must be named by the operator before publication. This field is intentionally not invented.'] },
        { heading: 'Hosting', paragraphs: ['Hosting provider, address and contact details must be recorded before publication. The public site and application are served from the operator deployment; no hosting provider is claimed here without verification.'] },
        { heading: 'Intellectual property', paragraphs: ['The QeyNox name, interface, design system and documentation are protected by the applicable intellectual property rules. Third-party names remain the property of their owners.'] },
        { heading: 'Contact', paragraphs: ['A verified public contact channel must be added before publication. Existing workspace members can use the authenticated Support entry.'] },
      ],
    },
    privacy: {
      title: 'Privacy — QeyNox',
      description: 'QeyNox privacy information: account and workspace data, missions and results, consented context, support conversations, audit records and the rights available to users.',
      intro: 'This page describes the data actually processed by the QeyNox product. Legal basis, retention periods and international transfer safeguards depend on the operator deployment and are marked for completion.',
      requiresPlaceholders: true,
      sections: [
        { heading: 'Data processed', paragraphs: ['QeyNox processes account identifiers (email address, password hash, locale), workspace membership and roles, session metadata, missions and their revisions, results and evidence records, consented context and consent choices, support conversations when the support integration is enabled, and platform audit records for administration and security.'] },
        { heading: 'Purposes', paragraphs: ['Data is processed to provide the service, authenticate users, isolate workspaces, execute and record missions, deliver results, provide support, secure the platform and meet the operator obligations. QeyNox does not use the public website for advertising profiles.'] },
        { heading: 'Legal basis and retention', paragraphs: ['The operator must document the applicable legal basis for each purpose and the retention period for each data category. These fields are not invented here and must be completed before publication.'] },
        { heading: 'Processors and transfers', paragraphs: ['The deployment may use hosting, database and support providers. The support integration uses the configured external support engine (Chatwoot) when enabled; no message is duplicated in the QeyNox database. The identity of processors, their locations and transfer safeguards must be completed by the operator. No marketing email provider is configured in this repository.'] },
        { heading: 'Your rights', paragraphs: ['Depending on applicable law, you may request access, rectification, erasure, restriction, objection or portability. In-product features allow you to inspect, edit, delete and revoke consented context and to sign out or revoke sessions. A verified data-protection contact must be added before publication.'] },
      ],
    },
    terms: {
      title: 'Terms of use — QeyNox',
      description: 'QeyNox terms of use: service description, account and workspace rules, acceptable use, availability, intellectual property, liability and applicable law pending completion.',
      intro: 'These terms describe the actual service behaviour implemented in QeyNox. Commercial terms, prices and jurisdiction must be completed and legally reviewed before publication.',
      requiresPlaceholders: true,
      sections: [
        { heading: 'Service', paragraphs: ['QeyNox is a Results-as-a-Service platform: users state business objectives, review governed work where required, and receive deliverables with sources and stated limitations. Available capabilities depend on the workspace configuration and the platform deployment.'] },
        { heading: 'Accounts and workspaces', paragraphs: ['Access requires an authorised account. Workspace roles and platform administration roles are distinct; a workspace role never grants platform administration. Credentials and sessions must be kept secure, and users must not attempt to access another workspace or another user data.'] },
        { heading: 'Acceptable use', paragraphs: ['Users must not use QeyNox for unlawful activity, to bypass permissions or approval gates, to attack the platform or third parties, or to misrepresent generated or partial work as independently verified truth. QeyNox does not promise financial or business success.'] },
        { heading: 'Availability and limits', paragraphs: ['The service depends on configured capabilities, external providers and platform limits. Features that are unavailable fail closed and are shown as unavailable. No uptime, performance or outcome guarantee is made on this site.'] },
        { heading: 'Intellectual property and liability', paragraphs: ['The operator and its licensors retain rights in the service. Deliverable usage rights, liability limits and the applicable law and jurisdiction must be defined in the completed legal terms before publication.'] },
      ],
    },
    cookies: {
      title: 'Cookies and local storage — QeyNox',
      description: 'QeyNox cookie information: strictly necessary HTTP-only session cookies used by the application and QeyNox Control, with no analytics or advertising cookies configured.',
      intro: 'This page lists the cookies actually used by the QeyNox applications. The public marketing pages do not set cookies.',
      requiresPlaceholders: false,
      sections: [
        { heading: 'Public website', paragraphs: ['The public pages are server-rendered and do not set analytics, advertising or preference cookies. No third-party tracking script is configured in this repository.'] },
        { heading: 'Application session cookie', paragraphs: ['The workspace application uses an HTTP-only, SameSite=Lax session cookie (qx-session) to authenticate requests to the configured QeyNox API. It is strictly necessary for the service and is removed on sign-out.'] },
        { heading: 'QeyNox Control session cookie', paragraphs: ['The internal administration desk, when deployed under /admin, uses a separate HTTP-only session cookie (qx-control-session). It is strictly necessary for platform administration and is independent from workspace sessions.'] },
        { heading: 'No analytics or advertising', paragraphs: ['No analytics, advertising, social or profiling cookie is configured. Because only strictly necessary cookies are used, no optional-cookie consent banner is currently required. If analytics or marketing tools are added, this page and the consent mechanism must be updated before activation.'] },
        { heading: 'Control', paragraphs: ['You can delete cookies through your browser. Removing the session cookie signs you out of the application. The operator must name the cookie configuration owner and any consent tooling before publication.'] },
      ],
    },
  },
  pending: { title: 'To be completed before publication', intro: 'The operator must verify and fill the following fields. They are not invented in this repository.' },
};

const fr: SiteCopy = {
  nav: { home: 'Accueil', how: 'Fonctionnement', manifesto: 'Manifeste', contact: 'Contact', signin: 'Se connecter', enter: 'Ouvrir MyDash' },
  brandCaption: 'Results as a Service',
  language: 'Langue',
  footer: {
    tagline: 'QeyNox transforme un objectif métier exprimé en travail encadré et en résultat étayé. Aucune promesse de réussite commerciale ou financière.',
    legalTitle: 'Informations légales',
    pending: 'Données légales à compléter avant publication.',
  },
  home: {
    title: 'QeyNox — intelligence métier, résultats étayés',
    description: 'QeyNox est une plateforme Results-as-a-Service : exprimez un objectif métier, examinez le plan encadré, recevez un résultat concret avec ses sources, ses limites et la prochaine action.',
    eyebrow: 'Results as a Service',
    h1: 'Un résultat métier utile, pas du théâtre d’agents.',
    lead: 'Exprimez le résultat attendu. QeyNox mobilise les capacités métier disponibles et autorisées, réalise le travail qu’il peut vérifier et livre un résultat concret, inspectable et utilisable — avec ses sources, ses limites et votre approbation aux étapes décisives.',
    primary: 'Ouvrir MyDash',
    secondary: 'Voir le fonctionnement',
    valuesTitle: 'Ce pour quoi QeyNox est conçu',
    values: [
      { title: 'Des objectifs, pas des prompts', body: 'Une mission part d’un objectif métier et de la décision qui le motive. L’interface reste centrée sur le résultat et la prochaine action utile.' },
      { title: 'Un travail encadré', body: 'Les outils sont médiés, les permissions échouent en mode fermé et les actions décisives exigent une approbation humaine. Une capacité non configurée reste inactive au lieu d’être simulée.' },
      { title: 'Des preuves datées et inspectables', body: 'Les sources sont enregistrées avec leurs dates et leurs limites. Un résultat est un livrable, pas une promesse de croissance ou de profit.' },
    ],
    stepsTitle: 'De l’objectif au résultat utilisable',
    steps: [
      { title: 'Décrivez l’objectif', body: 'Expliquez ce que vous devez comprendre, décider ou livrer. Ajoutez les contraintes importantes, notamment d’accès et de budget lorsqu’elles s’appliquent.' },
      { title: 'Examinez et approuvez', body: 'Examinez le périmètre proposé et toute demande d’approbation avant une exécution décisive. Vous restez le décideur.' },
      { title: 'Inspectez le résultat étayé', body: 'Lisez le livrable, ses sources, ses limites et la prochaine action proposée. Revenez plus tard pour poursuivre ou réviser le travail.' },
    ],
    evidenceTitle: 'Ce que vous pouvez vérifier',
    evidenceIntro: 'QeyNox est conçu pour que la confiance vienne de preuves inspectables, pas d’affirmations soignées.',
    evidence: [
      'Des sources enregistrées avec dates de consultation et limites explicites',
      'Un statut de revue explicite pour les constats partiels, non vérifiés ou provisoires',
      'Un historique des opérations et révisions dans votre workspace',
      'Des points d’approbation avant les actions externes décisives',
    ],
    limitsTitle: 'Des limites explicites',
    limits: 'QeyNox ne promet aucune réussite financière ou commerciale et n’est ni un CRM, ni un système d’exploitation universel de productivité, ni un décideur autonome. Les capacités disponibles dépendent de ce qui est configuré et autorisé pour votre workspace ; ce qui est indisponible est affiché comme indisponible.',
    manifestoTitle: 'Des résultats, pas du théâtre d’agents',
    manifestoBody: 'L’expertise métier doit être accessible sans expérience technique préalable. QeyNox est multilingue par conception, transparent sur les coûts et les limites, et garde les humains aux commandes des actions décisives.',
    manifestoLink: 'Lire le manifeste',
    ctaTitle: 'Commencez par un objectif clair',
  },
  how: {
    title: 'Fonctionnement de QeyNox — objectif, travail encadré, résultat étayé',
    description: 'Le parcours QeyNox : exprimez un objectif métier, examinez le périmètre et les approbations, recevez un livrable concret avec sources, limites et prochaine action.',
    h1: 'Le fonctionnement de QeyNox',
    lead: 'Une mission est une chaîne encadrée, d’un objectif exprimé à un livrable inspectable. L’interface expose ce qui compte : ce qui sera fait, ce que cela requiert, ce qui a été trouvé et ce qui reste incertain.',
    stepsTitle: 'Le parcours d’une mission',
    steps: [
      { title: '1. Objectif et contraintes', body: 'Vous décrivez le résultat métier et les contraintes importantes. QeyNox l’enregistre comme objectif de mission plutôt que comme une conversation ouverte.' },
      { title: '2. Plan, accès et approbation', body: 'Avant un travail décisif, vous pouvez examiner le périmètre, les accès requis et la demande d’approbation. Les outils sont médiés et les permissions échouent en mode fermé.' },
      { title: '3. Exécution et preuves', body: 'Les capacités configurées réalisent le travail autorisé. Sources, limites et statut du résultat sont enregistrés pour permettre une revue du livrable, pas seulement une croyance.' },
      { title: '4. Résultat et prochaine action', body: 'Vous recevez un résultat concret, inspectez ses preuves et décidez de la suite. Le travail peut être poursuivi, révisé ou interrompu dans les limites de la plateforme.' },
    ],
    doesTitle: 'Ce que QeyNox fait',
    does: [
      'Transforme un objectif métier exprimé en travail enregistré et encadré',
      'Utilise uniquement des capacités et outils configurés et autorisés',
      'Livre des résultats avec sources enregistrées et limites explicites',
      'Garde les humains aux commandes des approbations et actions décisives',
    ],
    doesNotTitle: 'Ce que QeyNox ne fait pas',
    doesNot: [
      'Promettre une réussite financière, commerciale ou professionnelle',
      'Fonctionner comme un essaim autonome ou remplacer votre jugement',
      'Simuler une capacité indisponible ou fabriquer des preuves',
      'Afficher des prix, témoignages ou performances non vérifiés',
    ],
    capabilitiesTitle: 'La disponibilité des capacités est honnête',
    capabilities: 'QeyNox expose uniquement les capacités métier configurées et autorisées pour un workspace. Si une capacité n’est pas disponible, le produit doit le dire au lieu de produire un résultat fictif. La disponibilité exacte dépend de la configuration du workspace et du déploiement de la plateforme.',
  },
  manifesto: {
    title: 'Le manifeste QeyNox — des résultats, pas du théâtre d’agents',
    description: 'Le manifeste QeyNox : intelligence métier au quotidien, expertise accessible, outils encadrés, sources datées et contrôle humain des actions décisives.',
    h1: 'L’intelligence métier au quotidien',
    lead: 'QeyNox met une équipe d’experts métier augmentée par l’IA à portée de main — un service, pas une promesse de profit.',
    paragraphs: [
      'L’utilisateur exprime un objectif ; QeyNox mobilise les capacités métier disponibles et les outils externes autorisés, réalise la recherche et le travail vérifié possible, puis livre un résultat concret et utilisable.',
      'QeyNox est un service, pas une promesse de profit. Il élargit l’intelligence et les capacités métier, et non un système d’exploitation universel de productivité personnelle. Les utilisateurs peuvent revenir chaque jour, lancer plusieurs opérations, suspendre ou réviser le travail et conserver leur contexte consenti.',
      'L’expertise métier doit être accessible indépendamment de l’expérience préalable. QeyNox est orienté international, multilingue par conception et transparent sur les coûts, les limites et les preuves.',
      'RaaS : des résultats, pas du théâtre d’agents. Les outils sont encadrés, les sources sont datées et les humains restent décideurs des actions décisives.',
    ],
    principlesTitle: 'Principes de fonctionnement',
    principles: [
      { title: 'Le résultat d’abord', body: 'Le résultat, la prochaine action et les livrables étayés dominent l’expérience ; les agents techniques restent derrière le produit.' },
      { title: 'La confiance par la preuve', body: 'Provenance, statut de revue, approbations et incertitude sont inspectables plutôt que masqués par un discours assuré.' },
      { title: 'Divulgation progressive', body: 'Montrer d’abord ce qui compte ; révéler les flux, budgets et niveaux de preuve à la demande.' },
      { title: 'Précision sobre', body: 'Interfaces disciplinées, limites claires et aucune mécanique d’engagement qui remplacerait un travail utile.' },
    ],
  },
  contact: {
    title: 'Contacter QeyNox',
    description: 'Comment contacter QeyNox : support authentifié du workspace, et canal public qui doit être complété avant publication.',
    h1: 'Contact',
    lead: 'Choisissez le canal adapté à votre demande. Nous ne publions ni adresse, ni numéro, ni identité légale qui n’ait été vérifiée.',
    supportTitle: 'Clients existants et membres d’un workspace',
    supportBody: 'Connectez-vous et utilisez l’entrée Support dans MyDash. Les conversations sont traitées dans le processus de support de la plateforme, avec l’isolation de compte et de workspace applicable à vos données QeyNox.',
    publicTitle: 'Demandes publiques ou prospectives',
    publicBody: 'Une adresse de contact publique sera publiée ici lorsque les informations légales et opérationnelles seront confirmées. Le site n’invente ni adresse e-mail, ni endpoint de formulaire, ni engagement de délai de réponse.',
    publicMissing: 'Adresse de contact publique : à compléter avant publication.',
    legalPendingTitle: 'Informations légales à compléter',
    legalPendingBody: 'Les pages légales décrivent déjà les usages réels de données et de cookies implémentés dans le produit. L’identité, l’hébergement, la juridiction et les durées de conservation restent signalés à compléter avant publication.',
  },
  legal: {
    notice: {
      title: 'Mentions légales — QeyNox',
      description: 'Mentions légales QeyNox. Les informations d’identité, d’hébergement et de juridiction sont explicitement signalées comme à compléter avant publication.',
      intro: 'Cette page identifie l’éditeur et l’hébergeur du site QeyNox. Les champs non vérifiés sont explicitement signalés et doivent être complétés avant publication.',
      requiresPlaceholders: true,
      sections: [
        { heading: 'Éditeur', paragraphs: ['Le service QeyNox est exploité par l’entité légale identifiée dans les informations complètes ci-dessous. Le nom, la forme juridique et le siège social ne sont pas encore publiés car ils n’ont pas été vérifiés dans ce dépôt.'] },
        { heading: 'Directeur de la publication', paragraphs: ['Le directeur de la publication doit être désigné par l’opérateur avant publication. Ce champ n’est volontairement pas inventé.'] },
        { heading: 'Hébergement', paragraphs: ['Le nom, l’adresse et le contact de l’hébergeur doivent être renseignés avant publication. Le site public et l’application sont servis par le déploiement de l’opérateur ; aucun hébergeur n’est affirmé ici sans vérification.'] },
        { heading: 'Propriété intellectuelle', paragraphs: ['Le nom QeyNox, l’interface, le design system et la documentation sont protégés par les règles de propriété intellectuelle applicables. Les noms de tiers restent la propriété de leurs titulaires.'] },
        { heading: 'Contact', paragraphs: ['Un canal de contact public vérifié doit être ajouté avant publication. Les membres d’un workspace peuvent utiliser l’entrée Support authentifiée.'] },
      ],
    },
    privacy: {
      title: 'Confidentialité — QeyNox',
      description: 'Informations de confidentialité QeyNox : compte et workspace, missions et résultats, contexte consenti, support, audit et droits des utilisateurs.',
      intro: 'Cette page décrit les données réellement traitées par le produit QeyNox. La base légale, les durées de conservation et les garanties de transfert dépendent du déploiement et restent à compléter.',
      requiresPlaceholders: true,
      sections: [
        { heading: 'Données traitées', paragraphs: ['QeyNox traite les identifiants de compte (adresse e-mail, empreinte de mot de passe, langue), l’appartenance et les rôles de workspace, les métadonnées de session, les missions et leurs révisions, les résultats et preuves, le contexte consenti et les choix de consentement, les conversations de support lorsque l’intégration est activée, ainsi que les journaux d’audit d’administration et de sécurité.'] },
        { heading: 'Finalités', paragraphs: ['Les données sont traitées pour fournir le service, authentifier les utilisateurs, isoler les workspaces, exécuter et enregistrer les missions, livrer les résultats, fournir le support, sécuriser la plateforme et respecter les obligations de l’opérateur. Le site public n’est pas utilisé pour du profilage publicitaire.'] },
        { heading: 'Base légale et conservation', paragraphs: ['L’opérateur doit documenter la base légale applicable à chaque finalité et la durée de conservation de chaque catégorie. Ces champs ne sont pas inventés ici et doivent être complétés avant publication.'] },
        { heading: 'Sous-traitants et transferts', paragraphs: ['Le déploiement peut utiliser des prestataires d’hébergement, de base de données et de support. L’intégration de support utilise le moteur externe configuré (Chatwoot) lorsqu’il est activé ; aucun message n’est dupliqué dans la base QeyNox. L’identité des sous-traitants, leurs localisations et les garanties de transfert doivent être complétées par l’opérateur. Aucun fournisseur d’e-mail marketing n’est configuré dans ce dépôt.'] },
        { heading: 'Vos droits', paragraphs: ['Selon le droit applicable, vous pouvez demander l’accès, la rectification, l’effacement, la limitation, l’opposition ou la portabilité. Les fonctionnalités du produit permettent de consulter, modifier, supprimer et révoquer le contexte consenti ainsi que de se déconnecter ou de révoquer des sessions. Un contact protection des données vérifié doit être ajouté avant publication.'] },
      ],
    },
    terms: {
      title: 'Conditions générales d’utilisation — QeyNox',
      description: 'CGU QeyNox : description du service, compte et workspace, usage acceptable, disponibilité, propriété intellectuelle, responsabilité et droit applicable à compléter.',
      intro: 'Ces conditions décrivent le comportement réellement implémenté de QeyNox. Les conditions commerciales, prix et la juridiction doivent être complétés et revus juridiquement avant publication.',
      requiresPlaceholders: true,
      sections: [
        { heading: 'Service', paragraphs: ['QeyNox est une plateforme Results-as-a-Service : les utilisateurs expriment des objectifs métier, examinent le travail encadré lorsque requis et reçoivent des livrables avec sources et limites explicites. Les capacités disponibles dépendent de la configuration du workspace et du déploiement de la plateforme.'] },
        { heading: 'Comptes et workspaces', paragraphs: ['L’accès requiert un compte autorisé. Les rôles de workspace et les rôles d’administration plateforme sont distincts ; un rôle de workspace ne donne jamais accès à l’administration plateforme. Les identifiants et sessions doivent être protégés, et les utilisateurs ne doivent pas tenter d’accéder à un autre workspace ou aux données d’un autre utilisateur.'] },
        { heading: 'Usage acceptable', paragraphs: ['L’utilisateur ne doit pas utiliser QeyNox pour une activité illicite, contourner des permissions ou des points d’approbation, attaquer la plateforme ou des tiers, ni présenter un travail généré ou partiel comme une vérité indépendamment vérifiée. QeyNox ne promet aucune réussite financière ou commerciale.'] },
        { heading: 'Disponibilité et limites', paragraphs: ['Le service dépend des capacités configurées, de prestataires externes et des limites de la plateforme. Les fonctionnalités indisponibles échouent en mode fermé et sont affichées comme telles. Aucune garantie de disponibilité, de performance ou de résultat n’est donnée sur ce site.'] },
        { heading: 'Propriété intellectuelle et responsabilité', paragraphs: ['L’opérateur et ses concédants conservent les droits sur le service. Les droits d’usage des livrables, les limites de responsabilité, le droit applicable et la juridiction doivent être définis dans les conditions complètes avant publication.'] },
      ],
    },
    cookies: {
      title: 'Cookies et stockage local — QeyNox',
      description: 'Informations cookies QeyNox : cookies de session HTTP-only strictement nécessaires pour l’application et QeyNox Control, sans analytics ni publicité configurés.',
      intro: 'Cette page liste les cookies réellement utilisés par les applications QeyNox. Les pages publiques de présentation ne déposent pas de cookies.',
      requiresPlaceholders: false,
      sections: [
        { heading: 'Site public', paragraphs: ['Les pages publiques sont rendues côté serveur et ne déposent ni cookie d’analytics, ni cookie publicitaire, ni cookie de préférence. Aucun script de suivi tiers n’est configuré dans ce dépôt.'] },
        { heading: 'Cookie de session de l’application', paragraphs: ['L’application workspace utilise un cookie de session HTTP-only, SameSite=Lax (qx-session) pour authentifier les requêtes auprès de l’API QeyNox configurée. Il est strictement nécessaire au service et est supprimé à la déconnexion.'] },
        { heading: 'Cookie de session QeyNox Control', paragraphs: ['Le desk d’administration interne, lorsqu’il est déployé sous /admin, utilise un cookie de session HTTP-only distinct (qx-control-session). Il est strictement nécessaire à l’administration plateforme et indépendant des sessions de workspace.'] },
        { heading: 'Aucun analytics ni publicité', paragraphs: ['Aucun cookie d’analytics, de publicité, de réseau social ou de profilage n’est configuré. Comme seuls des cookies strictement nécessaires sont utilisés, aucune bannière de consentement optionnelle n’est actuellement requise. Si des outils d’analytics ou de marketing sont ajoutés, cette page et le mécanisme de consentement devront être mis à jour avant activation.'] },
        { heading: 'Contrôle', paragraphs: ['Vous pouvez supprimer les cookies via votre navigateur. Supprimer le cookie de session vous déconnecte de l’application. L’opérateur doit nommer le responsable de la configuration cookies et tout outil de consentement avant publication.'] },
      ],
    },
  },
  pending: { title: 'À compléter avant publication', intro: 'L’opérateur doit vérifier et renseigner les champs suivants. Ils ne sont pas inventés dans ce dépôt.' },
};

export const publicCopy: Readonly<Record<Locale, SiteCopy>> = { en, fr };
