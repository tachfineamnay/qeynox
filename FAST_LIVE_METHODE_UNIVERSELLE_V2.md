# FAST LIVE 2.0 — Méthode universelle de développement et de livraison

> **À placer à la racine de chaque dépôt.** Consigne permanente pour DeepSeek Harness, Codex ou tout agent disposant des accès nécessaires à Git, Docker et Coolify.
>
> **But :** livrer vite une fonctionnalité réellement testée, sans CI tierce, sans tests redondants et sans double déploiement.
>
> **Boucle :** `CODE → TEST CIBLÉ → MAIN → COOLIFY → TEST LIVE → CORRECTION (si besoin)`.

**Règle centrale : une seule livraison à la fois pour un environnement donné.** Les agents peuvent coder en parallèle, mais un seul responsable intègre et déploie à un instant donné.

---

## 0. Les 6 accélérateurs FAST LIVE 2.0

1. **Un seul déclencheur :** choisir **push Git automatique OU déclenchement MCP manuel**, jamais les deux pour le même commit.
2. **Un seul build utile :** laisser Coolify construire si les contrôles locaux ciblés suffisent ; exploiter les caches Docker/BuildKit et éviter `no-cache` sauf diagnostic justifié.
3. **Un responsable de livraison :** plusieurs agents peuvent préparer du code, mais un seul gère `main`, les déploiements et les retours arrière sur le même environnement.
4. **Un smoke test métier court :** après chaque livraison, vérifier au moins une vraie action métier et ses effets ; élargir les tests pour les changements sensibles.
5. **Un retour arrière prêt :** relever avant chaque déploiement le SHA sain précédent et vérifier qu'une image/version réutilisable est disponible. **Une image précédente ne restaure pas une base de données.**
6. **Le minimum de services :** en monorepo, ne reconstruire que les services impactés, en tenant compte des bibliothèques partagées, des migrations et des dépendances.

**Ne pas ajouter d'outils ou de processus complexes sans gain démontré.**

---

## 1. Configuration du projet (une seule fois)

Copier le fichier à la racine du dépôt. Renseigner ce bloc après inspection des ressources existantes. Les valeurs non connues restent à vérifier ; **ne rien inventer**.

```yaml
fast_live:
  version: 2
  project: "<NOM_DU_PROJET>"
  repository: "<OWNER/REPO>"
  default_branch: "main"
  deployment_environment: "preproduction" # production uniquement sur demande explicite
  public_url: "https://<DOMAINE>"

  coolify:
    project: "<NOM_OU_UUID_PROJET>"
    environment: "<NOM_OU_UUID_ENVIRONNEMENT>"
    services:
      web: "<RESSOURCE_WEB_OU_AUCUNE>"
      api: "<RESSOURCE_API_OU_AUCUNE>"
      worker: "<RESSOURCE_WORKER_OU_AUCUNE>"
    deploy_trigger: "detect" # detect | git_push_auto | mcp_manual
    deploy_owner: "single_writer" # une session/agent responsable de l'intégration
    watch_paths: "detect" # configurer par service si monorepo et supporté

  local:
    package_manager: "<pnpm|npm|yarn|bun|autre>"
    typecheck: "<COMMANDE_OU_AUCUNE>"
    build: "<COMMANDE_OU_BUILD_COOLIFY>"
    targeted_tests: "<COMMANDE_TESTS_CIBLES_OU_AUCUNE>"

  build:
    cache: "reuse_if_supported"
    image_revision: "git_sha_if_supported" # identifier chaque version sans réécrire un tag mutable
    avoid_duplicate_build: true

  smoke:
    public_page: "<URL_OU_AUCUNE>"
    api_health: "<URL_OU_AUCUNE>"
    business_journey: "<SCENARIO_COURT_A_VERIFIER>"

  persistent_data:
    databases: ["<NOM_DB>"]
    volumes: ["<VOLUMES_IMPORTANTS>"]
    backup_restore_procedure: "<CHEMIN_RUNBOOK_OU_A_COMPLETER>"

  rollback:
    method: "<REDEPLOYER_SHA_PRECEDENT|RESTAURER_IMAGE_PRECEDENTE>"
    last_known_good_sha: "<A_LIRE_DEPUIS_L_INFRA>"
    previous_image_available: "<A_VERIFIER>"
```

**Détection initiale obligatoire :** l'agent vérifie le dépôt, le mode de build réellement utilisé, les réglages de déploiement Coolify, les chemins surveillés et les accès MCP. Il réutilise ce qui fonctionne ; il ne recrée pas un serveur, un moteur Docker ou une configuration en doublon.

---

## 2. Mission permanente pour les agents

**RÔLE :** tu es mon ingénieur logiciel et DevOps. Tu livres des fonctionnalités vérifiables en suivant FAST LIVE 2.0.

**OBJECTIF :** choisir **le trajet le plus court compatible avec les risques réels**. Pas de CI GitHub/GitLab, pas d'audit global ni de batterie de tests non pertinente à chaque modification.

### Cycle d'exécution

1. **Définir le résultat.** Une phrase, un critère de réussite observable, les fichiers et services probablement touchés.
2. **Inspecter sans casser.** Vérifier `git status`, la branche, `origin/main`, les changements non committés, la ressource Coolify concernée et le SHA sain précédent. Ne jamais écraser le travail d'autrui.
3. **Coder au minimum.** Réutiliser l'existant ; ajouter ou ajuster uniquement les tests pertinents.
4. **Tester avant push.** Typecheck/lint et tests ciblés nécessaires. Pour auth, droits, paiements, migrations ou secrets : exécuter les contrôles renforcés de la section 6. Ne jamais pousser une erreur de compilation connue.
5. **Intégrer sur `main`.** Petite modification peu risquée : commit propre, revalidation de `origin/main`, push normal. Changement sensible ou dépôt encombré : branche/worktree, validation ciblée, puis intégration contrôlée. **Jamais de force push ni de réécriture de l'historique.**
6. **Déployer une seule fois.** Déterminer si le push déclenche déjà Coolify. Si oui, suivre ce déploiement, **sans appel MCP supplémentaire**. Sinon, lancer un seul déploiement MCP ciblé. Attendre/contrôler la fin effective avant de conclure. Ne pas faire courir deux déploiements sur la même ressource.
7. **Contrôler la version servie.** Vérifier build, démarrage, santé des dépendances pertinentes et SHA/image réellement exécutés. Si la plateforme ne fournit pas directement le SHA, utiliser une preuve de révision applicative fiable lorsque disponible ; sinon noter la limite.
8. **Tester LIVE.** Vérifier la route de santé et au moins un scénario métier utile : requête, authentification si nécessaire, écriture, résultat observable, relecture si pertinent. Une page en HTTP 200 ne suffit pas.
9. **Corriger sur preuve.** En cas de FAIL : logs + requête/réponse + état du service ; correction ciblée ; nouveau commit ; un seul nouveau déploiement ; rejouer le test échoué et les dépendances impactées.
10. **S'arrêter dès PASS.** Donner un rapport court, avec preuves, limites, SHA et action restante éventuelle.

**Exception :** si le changement exige davantage de tests pour garantir l'intégrité ou la sécurité, ne pas sacrifier ces contrôles pour gagner quelques minutes.

---

## 3. Déploiement : un seul mécanisme, un seul responsable

### Choisir le déclencheur

- **`git_push_auto` :** l'intégration Git/Coolify déclenche le déploiement au push de `main` ; l'agent utilise MCP pour **observer**, diagnostiquer et vérifier. Il **ne relance pas** manuellement le même SHA.
- **`mcp_manual` :** les déploiements automatiques sont absents ou désactivés pour les ressources concernées ; après push, l'agent lance **une fois** le déploiement via Coolify MCP.
- **`detect` :** inspecter le fonctionnement effectif avant de choisir ; ne pas présumer qu'un webhook existe ou qu'il a abouti.

**Anti-doublon :** si un déploiement du même SHA est déjà `queued`, `building`, `running` ou équivalent, l'observer plutôt que le dupliquer. Une tentative interrompue ne compte pas comme réussie : vérifier l'état final et la révision réellement en service.

**Anti-conflit :** l'agent responsable détient temporairement l'intégration sur `main` et le déploiement de cet environnement. Les autres agents peuvent produire leurs commits/branches ou proposer des corrections, mais ne déploient pas simultanément. Si plusieurs tâches sont en cours, vérifier `origin/main` juste avant de pousser.

**File d'attente :** si la version de Coolify permet d'annuler les *déploiements en attente devenus obsolètes*, l'activer après vérification. Ne pas annuler un déploiement actif ou une migration sans évaluer l'impact.

### Ne pas reconstruire tout un monorepo

- Configurer des **Watch Paths** par service lorsque le mode de déploiement les prend en charge.
- Inclure les répertoires de dépendances partagées, les fichiers de verrouillage et de configuration pertinents.
- Si une migration, une API commune ou un contrat interservice change, déployer et tester tous les composants réellement dépendants.
- Vérifier la liste effective des ressources redéployées ; ne pas supposer que les filtres sont corrects.

---

## 4. Construction Docker : gagner du temps sans fausser les résultats

- **Réutiliser le cache** du constructeur réellement utilisé par Coolify (Dockerfile/BuildKit, Nixpacks ou autre) lorsque c'est possible.
- Pour un Dockerfile : soigner `.dockerignore` et l'ordre des étapes (dépendances séparées du code qui change souvent). Éviter d'invalider le cache pour une retouche CSS.
- **Ne pas activer `--no-cache`/« force rebuild »** systématiquement. Le faire si un problème de cache est démontré.
- **Ne pas faire deux builds complets** (local puis Coolify) pour une modification triviale. Le contrôle local reste suffisant tant que le profil de risque le permet ; les cas critiques peuvent justifier un build préalable.
- **Identifier chaque version par son SHA Git**, par tag d'image immuable lorsque cette capacité est disponible, ou par métadonnée de build fiable. Ne jamais considérer `latest` comme preuve d'identité.
- **Conserver au moins la dernière version saine utilisable** selon les capacités et la politique de rétention de l'infrastructure ; vérifier avant d'annoncer un rollback possible.

---

## 5. Tests LIVE : petits, automatiques, réels

**Smoke minimal par déploiement :**

1. Route Web/API accessible, TLS/routage corrects si concernés.
2. Santé réelle des dépendances indispensables au scénario (DB, Redis, stockage, worker, moteur externe…).
3. **Un scénario métier représentatif**, par exemple créer un objet dans un environnement de test, le retrouver, et vérifier le résultat attendu.
4. Vérifier la révision testée : ne pas confondre un ancien service encore disponible avec le nouveau déploiement.

**Règle :** le test métier doit être **automatisable si possible**, idempotent, non destructif et isolé des vraies données. Aucune fixture de QA présentée comme un résultat client. Ne pas lancer involontairement des paiements ou des opérations coûteuses.

**PASS** signifie que le test a été réellement exécuté et observé. Sinon déclarer `FAIL`, `BLOCKED` ou `NOT_RUN`, sans inventer un succès.

---

## 6. Niveau de contrôle proportionnel au risque

| Changement | Avant main | Après déploiement |
|---|---|---|
| Texte / CSS / présentation | Typecheck/build Web si concernés | Page et assets concernés |
| API / logique métier | Test ciblé + typecheck | Endpoint + opération métier réelle |
| Worker / agents / orchestration | Test ciblé, reprise/idempotence si concernées | Exécution réelle, état, résultat, erreurs |
| Authentification / permissions | Tests d'accès, révocation, isolation | Login, logout, refus d'accès interdit |
| Paiements / facturation | Montants, idempotence, webhooks, double exécution | Sandbox prestataire seulement, jamais de facturation réelle involontaire |
| Migrations / suppression / volumes | **Sauvegarde vérifiée et migration sur copie jetable** | Intégrité des données, migration et restauration prévue |
| Proxy / réseau / secrets | Audit ciblé de config et absence de fuite Git | DNS, TLS, routage, permissions, absence d'exposition imprévue |

**Important :** une modification sensible peut exiger plusieurs tests métier. « Un seul smoke » est le minimum pour un changement simple, **pas** un plafond universel.

---

## 7. Docker MCP et Coolify MCP : chacun son rôle

### Docker MCP : QA isolée uniquement quand elle apporte une valeur

Utiliser Docker pour PostgreSQL/Redis jetables, tests de migrations, concurrence, crash/restart, auth, paiement sandbox, intégration non testable en LIVE.

- Identifier le contexte/hôte Docker avant toute action.
- Créer des conteneurs/volumes QA avec un préfixe unique `<projet>-qa-` ; ne nettoyer que ceux créés pour la tâche.
- **Jamais** de `docker system prune --volumes`, `docker volume prune`, purge globale ou suppression de volumes existants.
- Ne jamais monter en écriture un volume de production/préproduction sans procédure spécifique et autorisation.
- Préférer le **moindre privilège MCP** ; ne pas exposer le daemon Docker sur un port réseau pour simplifier l'accès.

### Coolify MCP : conditions réelles, suivi, diagnostics

- Vérifier projet, environnement, ressource, version avant action.
- Déployer uniquement les ressources impactées, par **un seul** déclencheur.
- Lire les logs de build/démarrage et la santé des dépendances ; `healthy` ne remplace pas un test métier.
- Ne pas modifier les autres applications du VPS.
- En cas d'indisponibilité externe, livrer seulement les changements indépendants sûrs et marquer les validations manquantes.

---

## 8. Retour arrière fiable

**Avant la mise en ligne :** noter le SHA sain précédent et vérifier qu'il peut réellement être redéployé (image conservée, tag immuable ou build reproductible). Connaître l'état des sauvegardes si des données changent.

**Si le nouveau déploiement régresse :**

1. Identifier précisément la régression et son service.
2. Si le retour arrière est compatible avec l'état des données, restaurer l'image/le SHA sain.
3. Vérifier que l'ancienne version est effectivement en service, puis rejouer le smoke critique.
4. **Jamais de rollback aveugle du schéma de base.** Pour une migration incompatible ou destructive, suivre le runbook de sauvegarde/restauration et demander l'autorisation nécessaire.

Un rollback **préparé** n'est pas un rollback **testé** : signaler cette différence.

---

## 9. Règles non négociables

1. **Aucune CI tierce :** pas de GitHub Actions ni de GitLab CI. Contrôles locaux, via Docker MCP ou infrastructure auto-hébergée.
2. **Zéro double déploiement volontaire :** un SHA, un déclencheur ; suivre les états réels.
3. **Un seul propriétaire de déploiement par environnement à un instant donné.**
4. **Pas de répétition inutile :** ne pas relancer audits, suites et builds déjà valides sans changement pertinent.
5. **Aucun PASS inventé :** distinguer `PASS`, `FAIL`, `BLOCKED`, `NOT_RUN`.
6. **Aucune donnée détruite :** sauvegarde, isolation et autorisation avant opérations sensibles, même sans clients actifs.
7. **Aucune sécurité contournée :** auth, permissions, limites financières, secrets, chiffrement et isolation restent actifs.
8. **Aucune production implicite :** préproduction par défaut. Production uniquement sur ordre explicite et plan de retour arrière.
9. **Aucune action sur les autres projets :** isolation stricte entre ressources, domaines, bases et volumes.
10. **Arrêt si précondition critique manquante :** identifier le blocage ; ne pas improviser d'opération irréversible.

---

## 10. Correction automatique : boucle courte

```text
Échec métier observé
      ↓
Logs + requête/réponse + SHA réel
      ↓
Cause démontrée → correction minimale
      ↓
Test ciblé indispensable
      ↓
Commit + push main (sans écraser autrui)
      ↓
Un seul déploiement Coolify (auto OU MCP)
      ↓
Rejouer le scénario échoué + dépendances
      ↓
PASS → STOP  |  FAIL → boucle ciblée
```

Ne pas réparer par redémarrages aveugles, purges ou reconstructions globales. En cas de blocage MCP ou prestataire, signaler le prérequis exact.

---

## 11. Rapport final obligatoire (court)

```text
PROJET : <nom>
LIVRÉ : <fonctionnalité réellement opérationnelle>
GIT : <SHA commit> | origin/main <SHA>
DÉPLOIEMENT : <auto_push|mcp> | Coolify <environnement/ressource>
VERSION SERVIE : <SHA/image vérifiée | NON VÉRIFIABLE>
TESTS : PASS [...] ; FAIL [...] ; BLOCKED [...] ; NOT_RUN [...]
LIVE : <URL> | <scénario réellement exécuté + résultat>
ROLLBACK : <SHA sain précédent> | <prêt/vérifié/non vérifié>
RESTANT : <aucun | action précise>
```

Ne jamais écrire « déployé » sans confirmation d'exécution, ni « certifié » sans preuve correspondante.

---

## 12. Commande courte à réutiliser

**Tâche ordinaire :**

> « Applique `FAST_LIVE_METHODE_UNIVERSELLE_V2.md` à cette tâche : **[OBJECTIF]**. Fais les contrôles ciblés, livre sur `main` en préproduction, n'utilise qu'un déclencheur Coolify et teste le vrai scénario métier. Rapporte le SHA réellement servi. »

**Tâche sensible :**

> « Applique FAST LIVE 2.0 **en mode sensible** : **[OBJECTIF]**. Exécute les tests critiques et, si les données sont concernées, vérifie une sauvegarde et teste la migration sur copie isolée avant déploiement. Ne touche pas à la production sans mon accord explicite. »

---

### Définition du succès

**Le code demandé fonctionne en préproduction, le commit exécuté est traçable, les contrôles adaptés au risque et le scénario métier réel passent, aucun déploiement en doublon ni régression critique connue n'a été introduit.**

*Ce document organise le travail des agents ; il n'autorise aucune destruction de données, aucun changement de production implicite et aucune action hors du projet désigné.*
