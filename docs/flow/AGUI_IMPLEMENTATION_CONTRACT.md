# Flow 2.0 — contrat d'intégration AG-UI

Statut : SSE en conception, non implémenté ni déployé ; projection read-only implémentée localement. Parcours Flow authentifié live : NOT_RUN. Hatchet orchestre, Hermes exécute, PostgreSQL fait foi ; l'API autorise et isole, Flow présente. Aucun nouveau moteur ni streaming simulé.

## Réalité et compatibilité

- `OperationReadModels.activity` lit les événements déjà projetés et renvoie `events`, `nextCursor` et `transport: POLLING` ; séquence croissante par opération, page de 1 à 100. L'ordre est celui de projection, pas une garantie d'ordre chronologique métier.
- `sync` et les lectures mission sont distincts ; les vues ne forment pas aujourd'hui un snapshot atomique. `eventId` source diffère de l'`id` d'enveloppe. `FlowEvent` actuel contient ces deux identifiants, `sequence`, `kind`, `occurredAt`.
- AG-UI 1.0 est stable avec schéma JSON : CUSTOM exige type, name, value. Sources officielles : [spécification 1.0](https://docs.ag-ui.com/spec/1.0), [schéma 1.0](https://github.com/ag-ui-protocol/ag-ui/blob/main/spec/1.0/schema.json), [transports](https://docs.ag-ui.com/spec/1.0/basic/transports). La forme proposée correspond au schéma ; validation et interopérabilité restent NOT_RUN.
- Une passerelle TypeScript/Next/Nest SSE est envisageable : les [Route Handlers Next](https://nextjs.org/docs/app/guides/backend-for-frontend) permettent un BFF et les réponses en streaming. Proxy, interruption, timeouts et déploiement restent à tester ; aucun SDK ni conformité de bout en bout ne sont certifiés.
- Ce flux de lecture d’événements métier CUSTOM a la forme AG-UI 1.0, mais n’est pas un endpoint RunAgent conforme complet : la spécification impose aussi entrée, cycle de vie, ordre et comportement. Aucun RUN_STARTED, RUN_FINISHED, STEP_*, texte ou delta inventé ; ce flux est distinct du streaming des tokens Hermes.

## Mapping, source et sémantique

| Source persistée réelle | Projection Flow | Enveloppe AG-UI proposée |
| --- | --- | --- |
| `OPERATION_CREATED` (`packages/persistence/src/store.ts`) | `FlowEvent` confirmé, libellé existant | `CUSTOM` `qeynox.flow.event.v1` |
| `EXECUTION_REQUESTED` (`packages/application/src/execution.ts`) | événement de demande, pas preuve d'exécution | même enveloppe |
| `PLAN_REVISED` (`packages/application/src/revisions.ts`) | événement de révision ; relire plan et version | même enveloppe |
| Autre `kind` réellement persisté | événement confirmé, libellé neutre si inconnu | même enveloppe ; jamais de statut déduit du nom |
| Chargement ou resynchronisation des lectures autorisées | signal de relecture et watermark, données séparées | `CUSTOM` `qeynox.flow.snapshot.v1` |
| Reprise impossible ou autorisation perdue | contrôle technique, sans transition métier | `CUSTOM` `qeynox.flow.control.v1` |

- Une notification invalide les lectures concernées ; l'UI relit les endpoints existants et ne reconstruit pas un état métier depuis les événements. Tout `kind` non reconnu est neutre. Ne pas publier `rawEvent`, `data`, prompts, réponses, secrets ou contexte privé ; `cleanProjection` est une liste d'exclusion insuffisante.
- États exacts de l'opération et des étapes/tentatives viennent des lectures serveur ; `INTERRUPT_REQUESTED` n'est pas `INTERRUPTED`. Capacités et travail actif viennent du plan et des tentatives réellement exposés, jamais d'un agent fictif. `WAITING_APPROVAL` n'invente ni approbation ni décision ; `RESULT` exige un document réellement accessible.
- Claims, citations, provenance, statut et limites proviennent des lectures de résultats/documents autorisées, non du flux ; une preuve absente ou non vérifiée reste telle quelle. Valider les liens avec les règles existantes ; ne pas transformer un compte de claims en preuve vérifiée.

## Contrats TypeScript proposés

Les noms et routes ci-dessous sont à créer ; ils ne décrivent pas des API déjà disponibles. Valider les messages à l'exécution, rejeter les champs supplémentaires et les versions inconnues. Identifiants et horodatages proviennent des sources autorisées.

```ts
type Cursor = number; // entier sûr >= 0, propre à l'opération et au workspace
type FlowEventV1 = { id: string; eventId: string; sequence: Cursor;
  kind: string; occurredAt: string };
type FlowWireV1 =
  | { type: 'CUSTOM'; name: 'qeynox.flow.event.v1';
      value: { operationId: string; event: FlowEventV1 } }
  | { type: 'CUSTOM'; name: 'qeynox.flow.snapshot.v1';
      value: { operationId: string; watermark: Cursor } }
  | { type: 'CUSTOM'; name: 'qeynox.flow.control.v1';
      value: { code: 'RESNAPSHOT' | 'SESSION_ENDED' | 'UNAVAILABLE' } };
```

- Liste d'autorisation stricte : uniquement les champs ci-dessus, après contrôle de visibilité pour l'utilisateur et la mission. Les métadonnées d'un événement filtré ne sont pas révélées ; un checkpoint technique autorisé peut avancer le curseur sans révéler son contenu. Aucune mutation ne passe par ce flux.
- L'adaptateur conserve les types de présentation `FlowEvent`/`FlowModel` existants ; les fonctions de mapping, validation et déduplication restent séparées de la vue. Ne pas supposer qu'un SDK AG-UI accepte ce flux de lecture comme une exécution complète : test d'interopérabilité explicite requis.

## Transport, sécurité et reprise

- **Décision : aucune migration de session obligatoire pour un SSE BFF sécurisé sous le modèle HttpOnly actuel.** actions.ts écrit qx-session contenant le bearer et le workspace avec HttpOnly, SameSite=Lax, expiration et Secure en production seulement. HttpOnly empêche la lecture JavaScript ordinaire mais le navigateur stocke et transmet le bearer : ce n’est pas zéro jeton dans le navigateur au sens littéral. Interdire sa valeur au code client, URL, réponses, événements et logs ; si absence physique du bearer dans le navigateur est exigée, un cookie opaque et un stockage serveur restent nécessaires.
- Navigateur → BFF Next même origine : GET /api/flow/operations/:operationId/stream avec cookie existant ; BFF → API : bearer et workspace par Authorization et x-qeynox-workspace côté serveur, origine autorisée par api-origin.ts. Ne pas transmettre le cookie à l’API ni refléter ses en-têtes. TLS externe obligatoire ; vérifier l’isolation et la protection de toute liaison HTTP privée autorisée.
- Le GET SSE est en lecture seule : SameSite=Lax ne suffit pas contre tous contextes cross-site/same-site. Contrôler Origin quand présent et Sec-Fetch-Site suivant une politique explicite, refuser les origines non autorisées, ne pas ouvrir CORS aux tiers, limiter les connexions ; tester les en-têtes absents, qui ne constituent pas une authentification.
- SSE unidirectionnel : `text/event-stream`, `Cache-Control: no-store, no-transform`, désactivation du buffering proxy, commentaires heartbeat sans identifiant ni donnée ; limites de connexions/taille, délai d'inactivité, gestion de backpressure et annulation au départ du client. Vérifier concrètement le support streaming de Next et du proxy de déploiement.
- session() vérifie seulement forme et expiration locale ; AuthenticationGuard et verifyBearer vérifient hash, expiration, révocation, utilisateur actif et appartenance active à chaque requête API. activity appelle getOperation et filtre workspace/opération ; aucun contrôle de rôle fin supplémentaire n’est démontré ici. Revalider via l’API avant chaque émission et au moins toutes les 30 s, fermer sur refus, erreur ou expiration ; révocation externe sans émission détectée sous 30 s au maximum, borne à tester.
- Déconnexion : logout demande la révocation API puis efface le cookie même en cas d’échec ; cet échec ne prouve pas la révocation du bearer. Fermer le flux client, notifier les autres onglets sans secret, conserver l’avertissement existant ; pas de promesse de fermeture serveur immédiate si la révocation échoue.
- Chaque SSE `id` est la séquence confirmée ; `Last-Event-ID` prime sur `after` initial, tous deux validés comme entiers sûrs et bornés. Le serveur reprend `sequence > cursor` pour la même opération autorisée. Un checkpoint sans métadonnée métier permet d'avancer après filtrage ; l'ID n'est jamais avancé avant traitement des éléments précédents.
- Le client déduplique par `(operationId,eventId)` et ignore les séquences déjà acquittées ; un trou numérique seul ne prouve pas une perte si une politique filtre des événements. Aucune animation pour historique, replay ou chargement initial ; seul un événement confirmé après synchronisation peut déclencher le signal existant, sous reduced-motion.
- Amorçage sans trou : obtenir un watermark H autorisé, charger les lectures existantes puis rejouer strictement après H ; les événements rejoués ne font qu'invalider/relire, même si la lecture reflète déjà des données plus récentes. Ne jamais prétendre que ces lectures sont atomiques : détecter incompatibilités de version/révision, signaler `stale` et relire ; si cohérence requise, ajouter une lecture transactionnelle dédiée avant certification.
- Reconnexion bornée avec backoff/jitter, contrôle des droits et replay depuis le dernier curseur traité ; si curseur invalide, futur ou hors rétention, envoyer `RESNAPSHOT`, fermer le client puis reprendre un amorçage. Ne pas supposer qu'une rétention existe : définir et tester son plancher avant purge. Détecter et éviter les boucles de reconnexion `EventSource` ; un contrôle SSE explicite ou une prévalidation JSON est nécessaire car `EventSource` ne fournit pas les statuts HTTP détaillés.
- À chaque reconnexion, relire le cookie courant et revalider via API sans réutiliser un principal capturé ; refuser les curseurs associés à un autre workspace ou opération. Tester révocation pendant attente, perte du réseau et flux ouvert lors du changement de workspace.
- Si flux indisponible, fermer SSE et utiliser le polling existant de 10 s sous ses conditions de visibilité/formulaire, sans seconde boucle concurrente ; reprendre et dédupliquer avant retour SSE. Afficher une vue périmée si les lectures échouent, pas un succès. Réseau/erreurs temporaires : `UNAVAILABLE` ; droits/session perdus : `SESSION_ENDED`, effacer données en mémoire et ne pas réessayer automatiquement ; aucune erreur sensible en sortie.
- La passerelle peut interroger les projections persistées à intervalle borné : cela améliore le transport mais ne promet ni instantanéité ni nouveaux événements. Mesurer charge, latence et limites avant activation ; aucune écriture métier ni ordonnanceur.

## Fichiers et lots pour DeepSeek Flash 4.1

1. **Authentification existante** : conserver apps/web/src/lib/actions.ts, api.ts, api-origin.ts et apps/api/src/auth/auth.guard.ts, auth.service.ts ; session() exclusivement côté serveur. Aucun nouveau magasin ni changement auth obligatoire. Migration optionnelle vers cookie opaque et magasin partagé protégé si l’absence physique du bearer dans le navigateur est imposée.
2. **Projection et accès** : `packages/application/src/read-models.ts`, `apps/api/src/activity/activity.controller.ts`, `activity.module.ts` ; ajouter validation des curseurs, contrôle explicite de visibilité, reprise et lecture cohérente si nécessaire. Garder PostgreSQL source de vérité, pas de modification Hermes/Hatchet.
3. **Passerelle et schémas** : nouvelle route `apps/web/src/app/api/flow/operations/[operationId]/stream/route.ts`, nouveaux `apps/web/src/lib/flow-stream-contract.ts` et `flow-stream.ts` ; schémas versionnés, SSE, contrôle de session, nettoyage et limites. Aucun `api()` JSON existant utilisé tel quel pour un flux.
4. **Client et continuité** : `apps/web/src/lib/flow-model.ts`, `apps/web/src/components/flow/types.ts`, `event-timeline.tsx`, `apps/web/src/components/mission-controls.tsx` et route mission si nécessaire ; intégrer déduplication, relectures, fallback et signal visuel existant, préserver actions, focus, FR/EN et accessibilité.
5. **Tests ciblés** : nouveaux tests des schémas et de la passerelle près des fichiers concernés ; compléter `apps/web/scripts/flow2-mission-qa.mjs` seulement pour comportement client, sans fixture produit. Tester validation, curseurs, événements tardifs, doublons, filtres, reprise, panne et cohérence.

## Certification métier prévue, pas encore exécutée

- Base PostgreSQL QA jetable `QEYNOX_QA_DATABASE_URL`, workspace et mission QA autorisés, deux utilisateurs/workspaces isolés ; session fournie par un opérateur autorisé, jamais de mot de passe, cookie, bearer ou contenu sensible dans les journaux/captures. Pas de session de production ni modification de données réelles.
- Vérifier connexion Flow, RUNNING réel, approbation réelle si disponible et document/preuves réels si disponibles ; sinon NOT_RUN pour chaque cas absent. Observer un événement persisté, vérifier `eventId`/séquence, relecture et une seule animation ; aucun faux événement ni exécution déclenchée pour remplir le test.
- Couvrir cookie HttpOnly/Secure en production/SameSite/expiration, accès JS impossible et absence du bearer dans réponses, URL, événements et logs ; session expirée/révoquée, logout confirmé ou non, changement workspace, membre retiré, accès croisé, erreurs et reconnexion. Tester contrôles Origin/Fetch Metadata, CORS, GET sans effet métier, connexions cross-site/same-site et limites.
- Tester aussi replay, pagination, doublons, filtrage, panne, curseur invalide, fallback sans concurrence, reduced-motion et absence de fuite après révocation ; mesurer la charge et conserver des preuves expurgées.
- Exécuter les contrôles applicables d'AGENTS.md avec leurs prérequis ; consigner PASS/FAIL/NOT_RUN séparément, preuves expurgées et limites de déploiement. Aucun PASS métier ou protocolaire complet sans exécution effective.

## Annexe — brief présent localement avant cette mise à jour

#
QEYNOX — FLOW 2.0 / AG-UI CONTRACT
MODE : FAST LIVE V2
THINKING : HIGH

CONTEXTE
Flow 2.0 est déployé sur main, SHA 652b154.
PASS technique live, parcours métier authentifié NOT_RUN.

OBJECTIF
Concevoir le raccordement des événements réels
QeyNox à Flow via AG-UI, sans recréer de moteur
d'orchestration.

RÔLES EXISTANTS
- Hatchet : orchestration durable
- Hermes : exécution agentique
- PostgreSQL : vérité métier
- Flow : interface utilisateur
- API QeyNox : autorisations et isolation tenant

MISSION
1. Lis FLOW2_CONTRACT.md, FLOW2_STATUS.md et
   les seuls contrats réels d'activité, d'événements,
   de sessions et de read models.

2. Vérifie le protocole AG-UI officiel et sa
   compatibilité avec notre stack.

3. Définis le mapping :
   événement métier → FlowEvent → événement AG-UI
   sans inventer de statut ni diffuser de données privées.

4. Spécifie :
   - Transport authentifié
   - SSE ou alternative justifiée
   - Curseur, replay et déduplication
   - Reconnexion et fallback polling
   - États de tâches et capacités
   - Evidence et provenance
   - Contrôle des permissions workspace
   - Gestion des erreurs

5. Prépare les contrats TypeScript et les fichiers
   à modifier pour DeepSeek Flash 4.1.

6. Prévois un test métier Flow authentifié
   avec une session QA autorisée, sans identifiants
   ni cookies dans les logs.

LIVRABLE
docs/flow/AGUI_IMPLEMENTATION_CONTRACT.md
Maximum 180 lignes.

INTERDIT
- Refaire le dashboard
- Modifier Hermes ou Hatchet inutilement
- Faux streaming ou faux agents
- Exposer un token au navigateur
- Déployer ou modifier la production

Pas de refonte, pas d'audit global.
Rapport final : 8 lignes maximum.
