# Flow 2.0 — contrat de préparation

Statut : proposition d'interface et d'adaptateur, pas une API ou un runtime existant. Baseline inspectée : `fbede41bd9cd0c686f03193b2766b70fe2566c76`. Les ADR et contrats réels priment ; tout écart exige une décision avant implémentation.

## Sources et limites constatées

- `apps/web/src/app/[lang]/missions/[id]/page.tsx` lit opération, plan, disponibilité, résumé, activité, Pilot, commerce, claims, documents et contexte par requêtes distinctes ; ces réponses ne constituent pas un snapshot atomique.
- `GET /v1/operations/:id`, `/plan`, `/readiness`, `/timeline`, `/results` et `/documents` ; `GET /v1/mydash/operations/:id/summary` et `/activity?after=&limit=` existent. L'activité renvoie `events`, `nextCursor`, `transport: POLLING`, pas un flux temps réel garanti.
- `packages/application/src/plan-read.ts` expose étapes, tentatives, approbations et capacités ; `apps/web/src/lib/mission.ts` valide les lectures. Le rafraîchissement actuel est périodique sur mission active, sous conditions de visibilité et de formulaire.
- PostgreSQL/Core porte la vérité ; Hatchet reste l'unique exécuteur durable, Hermes le runtime d'intelligence remplaçable et ToolBroker médie les outils. Soul gère le contexte consenti ; Pilot guide décisions et approbations sans ordonnanceur.
- Huit emplacements de capacités sont configurables ; ne montrer comme actifs que ceux effectivement configurés et disponibles. Aucun agent nommé, progrès ou résultat ne doit être inventé.

## Contrats proposés pour les prochains lots

Les noms suivants sont des types de présentation à construire dans `apps/web`, non des champs ou endpoints déjà disponibles. Vérifier les schémas et droits au moment du lot ; aucun accès direct à la base depuis le navigateur.

### FlowSnapshot

- `operation`: id, titre, statut réel, version, révision courante, date de dernière activité ; `objective` et contraintes depuis le plan si présents.
- `steps[]`: id, ordre, titre, description, dépendances, état, capacité associée et tentatives disponibles ; `approvals[]`: id, objet, état, échéance, tentative, indicateur périmé.
- `summary`: comptes et curseur fournis par le serveur ; `documents[]`, claims et sources restent des données distinctes avec leurs statuts et versions.
- `readiness`, prochaine action Pilot et disponibilité de chaque lecture : `available | loading | empty | denied | error | stale`. Ne jamais transformer une lecture échouée en liste vide ni en succès.
- Conserver version/révision et horodatage de chaque lecture ; les requêtes parallèles peuvent diverger. Si versions ou révisions incompatibles, marquer la vue périmée, désactiver les actions dépendantes et relire ; ne pas promettre une cohérence atomique.

### FlowEvent

- Adapter uniquement les événements persistés : `eventId`, `sequence`, `kind`, `occurredAt`, et métadonnées autorisées si effectivement reçues. `id` de l'enveloppe et `eventId` source ne sont pas interchangeables.
- Curseur par opération et workspace ; ordre par `sequence`, déduplication par `eventId`, pagination via `nextCursor`. En cas de trou, reprise depuis le dernier curseur confirmé puis relecture du snapshot ; ne pas inférer des transitions manquantes.
- Événement inconnu : libellé neutre et détails sûrs disponibles ; ne pas déduire un acteur, une tâche ou une réussite. Les champs non exposés restent absents.

### FlowSurface

- Modèle de présentation dérivé du snapshot : en-tête objectif/statut, plan et activité, prochaine décision, résultats et inspecteur de l'élément sélectionné.
- `RUNNING`, `WAITING_APPROVAL`, `RESULT` sont des vues, pas de nouveaux statuts serveur. Prévoir aussi chargement, vide, accès refusé, indisponible, échec, interruption et données périmées.
- `RESULT` exige un document réellement accessible ; afficher son statut propre (`DRAFT`, `PARTIAL`, `READY_FOR_REVIEW`, `DELIVERABLE`) indépendamment du statut de mission. Aucun résultat supposé à partir de `COMPLETED`.

### FlowAction

- Descripteur UI proposé : `kind`, cible, libellé localisé, disponibilité, raison d'indisponibilité et confirmation éventuelle ; le serveur reste l'autorité sur droits, état et préconditions.
- Réutiliser les actions existantes : démarrer, interrompre, reprendre/refaire une tentative admissible, réviser le plan, décider une approbation, examiner les claims, assembler/livrer et exporter selon les contrats effectifs.
- Transmettre version attendue, identifiants de révision/tentative/approbation et clé d'idempotence là où le contrat existant les exige. Après réponse, relire l'état ; un clic ou une requête acceptée ne prouve pas l'effet final.

## Agents, tâches et importance

- Représenter une capacité réelle et son rôle métier seulement si le plan l'expose ; ne pas personnifier une tentative en agent autonome ni attribuer une action à Hermes ou à un acteur inconnu. Les détails techniques restent secondaires.
- Chaque tâche présente titre, état serveur, dépendances et dernière tentative disponible ; l'historique et les erreurs se consultent dans l'inspecteur. `PENDING`, `RUNNING`, `WAITING_APPROVAL`, `COMPLETED`, `FAILED`, `SKIPPED`, `INVALIDATED` restent distincts.
- Hiérarchie : décision bloquante et résultat utile d'abord, puis travail en cours, ensuite historique. Une importance éditoriale locale ne modifie ni priorité d'exécution ni statut métier ; aucun score de valeur ou ROI inventé.
- Un résultat affiche affirmation, statut, limites, sources et prochaines actions disponibles. Un claim non vérifié, partiel ou contradictoire ne devient jamais « vérifié » par sa présentation ; la livraison et le stockage ont leurs propres états.

## Composition Professional Blue 2.0

- « 2.0 » désigne cette composition, sans nouvelle identité visuelle : tokens `docs/design/design-tokens.css`, navigation navy, accent cobalt, canvas clair et surfaces blanches ; contraste AA et statut exprimé par texte et icône, pas couleur seule.
- En-tête compact centré sur objectif, état réel et action pertinente ; plan lisible en cartes ou liste reliées par dépendances réelles, sans faux graphe de robots. Résultat et preuve restent prioritaires sur la décoration.
- Bureau : navigation existante (cible 272 px), contenu fluide, plan/activité au centre et inspecteur contextuel adjacent si l'espace le permet ; celui-ci présente détails, provenance et actions de la sélection, sans masquer l'objectif.
- Tablette : navigation réduite ou tiroir ; inspecteur en panneau superposé accessible si largeur insuffisante. Mobile (<768 px) : barre supérieure, menu accessible, contenu en une colonne, cartes empilées et inspecteur en panneau/dialogue adapté à l'écran ; aucune information critique tronquée ni défilement horizontal.
- Fermer l'inspecteur restaure le focus sur son déclencheur ; nom accessible, focus visible et piégé pour un dialogue modal, Échap quand sûr. Cibles tactiles ≥44 px, navigation clavier, libellés EN/FR et expansion des textes ; respecter les règles de responsive et d'espacement du système.

## Trois états d'écran

1. **RUNNING** — statut réel et objectif en tête ; étapes et tentative active si connues, activité horodatée et prochaine action Pilot disponible. Interruption uniquement si autorisée et confirmée ; pas de pourcentage ou durée estimée sans donnée réelle.
2. **WAITING_APPROVAL** — décision en évidence avec objet, conséquences connues, échéance et contexte de la révision ; inspecteur accessible aux preuves et au plan. Approuver/refuser seulement si l'approbation est en attente, non périmée et autorisée ; confirmation puis état serveur relu. Si aucune approbation lisible, signaler le blocage sans en inventer.
3. **RESULT** — document réel et version en premier, statut et limites visibles, affirmations et citations inspectables, prochaines actions. Export/téléchargement seulement après confirmation du stockage ; `PENDING_UPLOAD` n'est pas disponible. Une mission terminée ne garantit aucun succès commercial.

## Événements, mouvement et reprise

- Un nouvel événement confirmé peut brièvement signaler la ligne concernée et actualiser les données pertinentes ; aucune animation de progression autonome, boucle décorative ou transition de réussite sur simple minuterie.
- Le polling existant et ses curseurs sont la base ; ne pas annoncer WebSocket/SSE ou livraison instantanée. Éviter les annonces répétées au rechargement et préserver sélection et focus. L'ordre serveur et le texte restent compréhensibles sans animation.
- Durées indicatives du système : 120–180 ms pour interaction, 180–240 ms pour tiroir ; `prefers-reduced-motion` supprime les mouvements non essentiels. Les erreurs et décisions importantes sont annoncées sobrement aux technologies d'assistance.
- À la reconnexion, relire le snapshot et reprendre après le dernier curseur confirmé ; dédupliquer les événements. Échec de lecture : conserver les données antérieures étiquetées périmées, proposer actualisation et ne pas rejouer une mutation automatiquement.

## Sécurité et corrections

- Session, isolation workspace, autorisations et validation serveur obligatoires ; ne jamais exposer secrets, prompts privés ou réponses brutes. Ne pas contourner ToolBroker, consentement Soul, limites de coût ou conditions d'exécution.
- Les contrôles désactivés expliquent la raison connue ; permission, tarif, fournisseur, preuve ou état inconnu bloquent l'action concernée. Toute action payante ou destructive exige la confirmation prévue et les protections serveur.
- Conflit de version, approbation expirée/périmée ou refus : conserver la saisie non sensible si possible, expliquer, relire et demander une nouvelle décision ; ne pas écraser une révision ni réutiliser silencieusement une approbation.
- Les corrections créent des révisions et conservent l'historique existant ; les reprises passent par les routes et contrôles en place, avec idempotence là où requise. Ne pas reconstruire un ordonnanceur dans le client.

## Lots suivants et critères de passage

1. **Adaptation lecture** — `apps/web/src/lib/mission.ts`, `plan.ts` et nouvel adaptateur local si utile ; typer/valider les réponses existantes, états partiels, curseurs et incohérences. Tests ciblés : isolation, pagination/doublons, erreurs et versions divergentes.
2. **Surface mission** — route mission existante, `components/mission-flow.tsx`, `mission-controls.tsx`, primitives et styles existants ; trois vues et inspecteur accessibles, EN/FR, sans données de démonstration en production. Aucun nouveau backend implicite.
3. **Actions et résultats** — `mission-actions.ts`, actions du flux et route résultat existantes ; réutiliser routes et validations serveur, vérifier refus, conflits, approbation périmée, double soumission, preuves et export indisponible.
4. **Vérification** — tests ciblés, typecheck/build appropriés, clavier/contraste et captures 1440×900, 1024×768, 390×844. Comparaison à `docs/design/reference/concept-02-professional-blue.png` **BLOCKED** tant que le fichier manque ; aucun PASS visuel inventé.

Les suites du dépôt et la base PostgreSQL jetable `QEYNOX_QA_DATABASE_URL` restent requises selon AGENTS.md lorsque leurs prérequis existent. External Hatchet/Hermes, stockage de production, licences/fraîcheur des fournisseurs et durcissement d'identité publique restent des gates de déploiement non certifiés ; aucune preuve de mise en production n'est déduite de ce document.
