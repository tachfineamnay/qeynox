# Flow 2.0 — statut

## Raffinement visuel — 2026-11-17

- Ajustements Web : ordre compact, inspecteur modal et retour du focus, capacités actives au centre, décision dédupliquée, résultats et limites enregistrés, signal d'événement de 220 ms.
- Vérification : typecheck Web et build Web **PASS** ; `test:flow2` **PASS** sur fixtures QA : approbation 35 assertions, RUNNING 8, RESULT 6.
- Navigateur, captures des neuf vues, focus, débordement, priorité visible et nouveau signal : **NOT_RUN** ; l'initialisation du navigateur a expiré. Les captures historiques de mission 1 ne vérifient pas ce lot.
- Le test Flow lancé dans le sandbox a échoué avant assertions sur l'accès au serveur local ; les trois variantes ci-dessus ont été exécutées hors sandbox. Aucun test de production.
- L'adéquation visuelle P0/P1 et les interactions restent à confirmer en navigateur ; la comparaison à l'image de référence demeure **BLOCKED** car elle est absente.

## Mission 0 — contrat documentaire

- Contrat de préparation préparé le 2026-11-16 ; implémentation Flow 2.0 **NOT_RUN** à ce stade.
- Baseline inspectée : `fbede41bd9cd0c686f03193b2766b70fe2566c76` ; commit contrat `e14d172`.
- `FlowSnapshot`, `FlowEvent`, `FlowSurface` et `FlowAction` sont proposés, pas des API existantes.
- Trois vues définies : RUNNING, WAITING_APPROVAL, RESULT ; états et preuves serveur font autorité.
- Comparaison au screenshot de référence : **BLOCKED**, fichier absent.
- Gates externes et certification de production : voir `docs/architecture/IMPLEMENTATION_MAP.md`.

## Mission 1 — surface mission vivante (2026-11-16)

Statut : **IMPLÉMENTÉE ET VÉRIFIÉE localement** ; aucun push ni déploiement. Branche courte
`codex/flow2-mission-surface`, un commit local (SHA consigné dans le rapport de livraison).

Périmètre : route existante `/[lang]/missions/[id]` uniquement, sans modification du backend.
Nouveaux composants sous `apps/web/src/components/flow/` : `FlowHeader`, `PhaseRail`, `NowCanvas`,
`AgentActivity`, `EventTimeline`, `ContextInspector`, orchestrés par `FlowWorkspace`. L'adaptateur
de lecture `apps/web/src/lib/flow-model.ts` et la copie EN/FR `apps/web/src/lib/flow-copy.ts` sont
alimentés exclusivement par les lectures existantes (opération, plan, readiness, résumé, activité,
Pilot, commerce, claims, documents, contexte/consentements Soul).

- États de lecture conservés : `available`, `empty`, `denied`, `error`, `stale` ; une lecture échouée
  n'est jamais rendue comme une liste vide, et une version plan/readiness divergente marque la vue
  périmée et désactive les actions dépendantes.
- Événements persistés uniquement : ordre par `sequence`, déduplication par `eventId`, curseur
  `nextCursor` conservé, libellé neutre + code brut pour un type inconnu ; enveloppe et eventId
  restent distincts dans l'inspecteur.
- Agents : seulement les capacités du plan dont une tentative est `RUNNING`/`WAITING_APPROVAL` ;
  aucun nom, acteur, progrès ou résultat n'est inventé ; le détail technique reste secondaire.
- Vues RUNNING, WAITING_APPROVAL et RESULT dérivées de l'état enregistré ; un document affiche son
  statut propre (DRAFT/PARTIAL/READY_FOR_REVIEW/DELIVERABLE) et rien n'est supposé de `COMPLETED`.
- Inspecteur contextuel : étape, tentative, capacité, événement, approbation, disponibilité des
  lectures, provenance et actions disponibles avec leur raison. Panneau adjacent ≥1440 px ; tiroir
  modal en dessous, focus piégé puis restauré, fermeture Échap, cibles ≥44 px.
- Copie EN/FR complète ; 1440×900, 1024×768 et 390×844 sans débordement horizontal.
- Fonctionnalités conservées : plan et sa révision, devis, budget, démarrage, interruption,
  approbations, revue des preuves, documents et exports, session et isolation workspace.
- Correction reliée à la composition mobile : la règle existante qui masquait `.desktop-nav` perdait
  la cascade face à `.sidebar nav{display:grid}` ; corrigée afin de rendre la barre compacte, le rail
  et l'inspecteur réellement utilisables sur téléphone.
- Motion : **non installé**. Le registre npm est inaccessible depuis cet environnement (échec TLS) et
  aucune dépendance n'était nécessaire ; animations CSS courtes (120–220 ms) pour le signal d'un
  nouvel événement et le tiroir, supprimées par la règle globale `prefers-reduced-motion`.
- Aucune donnée de démonstration dans l'application ; les fixtures sont confinées à la QA.

### Vérification (2026-11-16)

| Contrôle | Résultat |
|---|---|
| `pnpm --filter @qeynox/web typecheck` | **PASS** |
| `pnpm --filter @qeynox/web build` (Next 16.4.6, Turbopack) | **PASS** |
| `pnpm --filter @qeynox/web test:flow2` (WAITING_APPROVAL) | **PASS** — 35 assertions |
| `FLOW2_VARIANT=running pnpm --filter @qeynox/web test:flow2` | **PASS** — 8 assertions |
| `FLOW2_VARIANT=result pnpm --filter @qeynox/web test:flow2` | **PASS** — 6 assertions |
| `pnpm --filter @qeynox/web test:smoke` | **FAIL préexistant**, hors périmètre mission |

`test:smoke` attend « Availability cannot be confirmed » sur `/en/capabilities` alors que la page
non authentifiée affiche la connexion ; l'échec est reproduit sur la baseline `e14d172` après
`git stash` et rebuild, sans ce lot. La suite s'arrête avant les assertions mission ; elle n'a donc
pas été modifiée. Le harness ciblé `apps/web/scripts/flow2-mission-qa.mjs` couvre les trois vues,
EN/FR, l'échec partiel d'une lecture, la déduplication des événements et le tiroir mobile.

Captures (Chrome 157 headless) :

- `docs/flow/evidence/flow2-desktop-1440x900.png`
- `docs/flow/evidence/flow2-desktop-detail-1440x900.png`
- `docs/flow/evidence/flow2-tablet-1024x768.png`
- `docs/flow/evidence/flow2-mobile-390x844.png`
- `docs/flow/evidence/flow2-mobile-inspector-390x844.png`

Comparaison au screenshot de référence : **BLOCKED** — `docs/design/reference/concept-02-professional-blue.png`
est absent ; aucun PASS visuel n'est revendiqué. Base PostgreSQL jetable : **NOT_RUN**, aucun
changement backend/migration dans ce lot.

### Limites restantes

- Les lectures restent non atomiques ; seules les divergences de version plan/readiness sont
  signalées comme périmées.
- Le rafraîchissement reste le polling existant ; aucun SSE/WebSocket n'est annoncé.
- `test:smoke` est obsolète sur l'assertion capabilities et doit être mis à jour dans un lot dédié.
- Motion n'a pas été ajouté (registre hors ligne) ; une installation ultérieure exigerait la mise à
  jour du lockfile et un nouveau build.
- Certification de production, comparaison visuelle et gates externes restent bloqués.
