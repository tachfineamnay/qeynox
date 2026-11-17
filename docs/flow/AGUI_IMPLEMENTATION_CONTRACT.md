# Flow 2.0 — contrat d'intégration AG-UI

Statut : conception, rien n'est implémenté ni déployé. Baseline `652b154fec68e918c852c079f187047c720987da` ; parcours Flow authentifié live : NOT_RUN. Hatchet orchestre, Hermes exécute, PostgreSQL fait foi ; l'API autorise et isole, Flow présente. Aucun nouveau moteur ni streaming simulé.

## Réalité et compatibilité

- `OperationReadModels.activity` matérialise les événements persistés, puis renvoie `events`, `nextCursor` et `transport: POLLING` ; séquence croissante par opération, page de 1 à 100. L'ordre est celui de projection, pas une garantie d'ordre chronologique métier.
- `sync` et les lectures mission sont distincts ; les vues ne forment pas aujourd'hui un snapshot atomique. `eventId` source diffère de l'`id` d'enveloppe. `FlowEvent` actuel contient ces deux identifiants, `sequence`, `kind`, `occurredAt`.
- AG-UI définit notamment `CUSTOM` avec `type`, `name`, `value`, ainsi que des événements de cycle de vie, état et messages ; son architecture accepte plusieurs transports. Sources officielles : [événements](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/events.mdx), [architecture](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/architecture.mdx), [types SDK JS](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/sdk/js/core/events.mdx).
- Une passerelle TypeScript/Next/Nest SSE est conceptuellement compatible avec ces enveloppes ; la version SDK, sa licence, le registre, le proxy et l'interopérabilité restent à vérifier. Aucun SDK AG-UI installé ou fonctionnement complet certifié n'est supposé.
- Ce lot futur est un flux de lecture d'événements `CUSTOM` conformes à leur forme, **pas** un endpoint `RunAgent` AG-UI complet. Aucun `RUN_STARTED`, `RUN_FINISHED`, `STEP_*`, message ou delta n'est inventé pour une connexion ou un polling. L'exécution et les actions restent sur leurs contrats autorisés.

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

- Précondition bloquante : `qx-session` actuel contient le bearer dans un cookie HTTP-only (`apps/web/src/lib/api.ts`, `actions.ts`). Pour respecter « aucun token au navigateur », remplacer ce stockage par une session opaque aléatoire, `HttpOnly`, `Secure`, `SameSite`, avec bearer conservé uniquement côté serveur dans un magasin partagé, protégé et à durée limitée ; migration et révocation sûres à concevoir et tester. Ne pas activer le flux tant que ce prérequis n'est pas satisfait.
- Navigateur → BFF Next même origine : `GET /api/flow/operations/:operationId/stream`, cookie opaque ; BFF → API privée : bearer et workspace uniquement côté serveur. Pas de token dans URL, JS, réponse, stockage navigateur ou logs. Autoriser la mission par le principal vérifié, l'appartenance active et les permissions effectives à chaque connexion et revalidation ; jamais de workspace choisi par le client sans contrôle.
- SSE unidirectionnel : `text/event-stream`, `Cache-Control: no-store, no-transform`, désactivation du buffering proxy, commentaires heartbeat sans identifiant ni donnée ; limites de connexions/taille, délai d'inactivité, gestion de backpressure et annulation au départ du client. Vérifier concrètement le support streaming de Next et du proxy de déploiement.
- Session, permissions et appartenance sont revalidées côté API au plus tard toutes les 30 secondes et avant chaque émission ; fermeture à expiration, révocation, déconnexion ou changement de workspace détecté. Une révocation externe n'est donc pas instantanée : délai maximal de 30 s à tester ; invalider immédiatement lors d'une déconnexion/changement détecté localement.
- Chaque SSE `id` est la séquence confirmée ; `Last-Event-ID` prime sur `after` initial, tous deux validés comme entiers sûrs et bornés. Le serveur reprend `sequence > cursor` pour la même opération autorisée. Un checkpoint sans métadonnée métier permet d'avancer après filtrage ; l'ID n'est jamais avancé avant traitement des éléments précédents.
- Le client déduplique par `(operationId,eventId)` et ignore les séquences déjà acquittées ; un trou numérique seul ne prouve pas une perte si une politique filtre des événements. Aucune animation pour historique, replay ou chargement initial ; seul un événement confirmé après synchronisation peut déclencher le signal existant, sous reduced-motion.
- Amorçage sans trou : obtenir un watermark H autorisé, charger les lectures existantes puis rejouer strictement après H ; les événements rejoués ne font qu'invalider/relire, même si la lecture reflète déjà des données plus récentes. Ne jamais prétendre que ces lectures sont atomiques : détecter incompatibilités de version/révision, signaler `stale` et relire ; si cohérence requise, ajouter une lecture transactionnelle dédiée avant certification.
- Reconnexion bornée avec backoff/jitter, contrôle des droits et replay depuis le dernier curseur traité ; si curseur invalide, futur ou hors rétention, envoyer `RESNAPSHOT`, fermer le client puis reprendre un amorçage. Ne pas supposer qu'une rétention existe : définir et tester son plancher avant purge. Détecter et éviter les boucles de reconnexion `EventSource` ; un contrôle SSE explicite ou une prévalidation JSON est nécessaire car `EventSource` ne fournit pas les statuts HTTP détaillés.
- Si flux indisponible, fermer SSE et utiliser le polling existant de 10 s sous ses conditions de visibilité/formulaire, sans seconde boucle concurrente ; reprendre et dédupliquer avant retour SSE. Afficher une vue périmée si les lectures échouent, pas un succès. Réseau/erreurs temporaires : `UNAVAILABLE` ; droits/session perdus : `SESSION_ENDED`, effacer données en mémoire et ne pas réessayer automatiquement ; aucune erreur sensible en sortie.
- La passerelle peut interroger les projections persistées à intervalle borné : cela améliore le transport mais ne promet ni instantanéité ni nouveaux événements. Mesurer charge, latence et limites avant activation ; aucune écriture métier ni ordonnanceur.

## Fichiers et lots pour DeepSeek Flash 4.1

1. **Session opaque, prérequis** : `apps/web/src/lib/api.ts`, `apps/web/src/lib/actions.ts` et nouveau stockage serveur partagé à préciser ; conserver le contrat d'authentification, les contrôles API et les actions. Tests de connexion, rotation, révocation et isolation avant tout flux.
2. **Projection et accès** : `packages/application/src/read-models.ts`, `apps/api/src/activity/activity.controller.ts`, `activity.module.ts` ; ajouter validation des curseurs, contrôle explicite de visibilité, reprise et lecture cohérente si nécessaire. Garder PostgreSQL source de vérité, pas de modification Hermes/Hatchet.
3. **Passerelle et schémas** : nouvelle route `apps/web/src/app/api/flow/operations/[operationId]/stream/route.ts`, nouveaux `apps/web/src/lib/flow-stream-contract.ts` et `flow-stream.ts` ; schémas versionnés, SSE, contrôle de session, nettoyage et limites. Aucun `api()` JSON existant utilisé tel quel pour un flux.
4. **Client et continuité** : `apps/web/src/lib/flow-model.ts`, `apps/web/src/components/flow/types.ts`, `event-timeline.tsx`, `apps/web/src/components/mission-controls.tsx` et route mission si nécessaire ; intégrer déduplication, relectures, fallback et signal visuel existant, préserver actions, focus, FR/EN et accessibilité.
5. **Tests ciblés** : nouveaux tests des schémas et de la passerelle près des fichiers concernés ; compléter `apps/web/scripts/flow2-mission-qa.mjs` seulement pour comportement client, sans fixture produit. Tester validation, curseurs, événements tardifs, doublons, filtres, reprise, panne et cohérence.

## Certification métier prévue, pas encore exécutée

- Base PostgreSQL QA jetable `QEYNOX_QA_DATABASE_URL`, workspace et mission QA autorisés, deux utilisateurs/workspaces isolés ; session fournie par un opérateur autorisé, jamais de mot de passe, cookie, bearer ou contenu sensible dans les journaux/captures. Pas de session de production ni modification de données réelles.
- Vérifier connexion Flow, RUNNING réel, approbation réelle si disponible et document/preuves réels si disponibles ; sinon NOT_RUN pour chaque cas absent. Observer un événement persisté, vérifier `eventId`/séquence, relecture et une seule animation ; aucun faux événement ni exécution déclenchée pour remplir le test.
- Couvrir replay, pagination, doublons, filtrage et checkpoint, panne/reconnexion, curseur invalide, polling sans concurrence, reduced-motion ; arrêt et non-fuite après révocation, changement workspace et accès croisé refusé. Vérifier limites, absence de secrets et charge de connexions.
- Exécuter les contrôles applicables d'AGENTS.md avec leurs prérequis ; consigner PASS/FAIL/NOT_RUN séparément, preuves expurgées et limites de déploiement. Aucun PASS métier ou protocolaire complet sans exécution effective.
