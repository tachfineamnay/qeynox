# 🕵️ Insider — Ce que QeyNox est VRAIMENT (et ce que vous n'en voyez pas)
## Cartographie opportuniste du projet : fonctionnement, angles morts, segments, paris · octobre 2026

> Document écrit après relecture complète du fonctionnement réel : `engine/repo_scan.py` (analyse statique), `engine/research.py` (4 stages + fallback Bing/DDG + flags de confiance), `engine/dossier.py` (3 personas heuristiques), `engine/pipeline.py` (7 stages → statut `review`), `engine/launch.py` (workspace swarm), `web/app.py` (missions, hooks, multi-stacks). Chaque idée est ancrée dans ce qui EXISTE, pas dans du rêve.

---

## 1. Le reframe brutal : ce que vous avez construit sans le nommer

| Vous appelez ça… | C'est en réalité… | Conséquence stratégique |
|---|---|---|
| « QeyNox » | Une **usine GTM autonome avec checkpoint humain** (pipeline → dossier → validation → exécution swarm) | Vous n'avez pas un outil, vous avez un **modèle d'agence industrialisé** |
| « Stacks » | Des **clients** (ou des produits d'un portefeuille) | La vue Stacks = un gestionnaire de portefeuille d'agence |
| « Missions » | Des **produits d'exécution** packagés | Chaque mission a un prix de marché identifiable |
| « Swarm » | Le **fulfillment** (production) | C'est votre usine — vendable séparément |
| `stacks/<slug>/data/gtm.db` | ⚡ **Le vrai actif** : un graphe de marché qui s'accumule par stack (mots-clés × signaux × SERP × concurrents dans le temps) | Les rapports sont des *lectures* ; la base est le *capital*. Aucun concurrent ne peut copier un historique |
| `pipeline.json` | Une **audit trail** de production | Traçabilité = crédibilité B2B (facturable) |

**Lecture insider n°1** : QeyNox n'est pas un dashboard qui fait des rapports. C'est une **base de données d'intelligence de marché qui s'auto-alimente**, avec un agent de production au bout. Les gens paieront volontiers pour un rapport ; ils paieront BEAUCOUP plus pour un historique et une machine qui continue.

**Lecture insider n°2** : le moment « validation admin » est votre joyau cachée. Tout le marché des rapports IA souffre du même défaut : le déluge de documents que personne ne lit et dont personne ne répond. Votre architecture **human-in-the-loop obligatoire avant action** est exactement ce que les acheteurs B2B exigeants veulent en 2026 (gouvernance IA = tendance n°1 de votre propre research). Ne la vendez pas comme une contrainte : vendez-la comme « *un analyste, pas une machine à PDF* ».

---

## 2. Les 10 angles morts du fonctionnement actuel (audit sans pitié)

1. **Il n'y a aucun LLM dans la boucle.** Le dossier est 100 % déterministe : 3 personas en archetypes fixes (P1 méfiant / P2 curieux / P3 engagé), recommandations = templates. C'est un *assembleur de recherche*, pas encore un *stratège*. Le saut de valeur n°1 : un **stage de synthèse LLM** (Ollama local pour la souveraineté, ou LiteLLM vers n'importe quel provider) qui prend les données collectées (verbatims, mots-clés, concurrents, AEO) et produit des personas *clusterisés sur vos données réelles*, des angles de positionnement, et un executive summary avec niveau de confiance. Coût marginal : ~0,05-0,30 € par dossier. Impact : le dossier passe de « bien organisé » à « vendable 300-500 € ».

2. **La boucle ne se referme pas.** Onboarding → dossier → validate → …rien ne revient vers QeyNox. Le dossier est une photo, pas un organisme. Manque : **re-scan au git push** (webhook GitHub/GitLab → diff du produit → « votre offre a changé, voici l'impact GTM ») et **re-génération incrémentale du dossier** (versioning + diff — les fichiers datés existent déjà, il manque la vue timeline).

3. **Le swarm ne parle pas à QeyNox, il lui remet des devoirs.** Actuellement : les agents lisent des fichiers et poussent des livrables via hook entrant. Il manque le sens inverse : un **serveur MCP QeyNox** (`get_keywords`, `get_signals`, `get_dossier`, `run_mission`, `propose_decision`) — en 2026, MCP est LE canal de distribution des outils agents (Claude Code, OpenClaw, Hermes sont tous MCP-natifs). Un serveur MCP de 150 lignes transforme QeyNox en ressource native de n'importe quel agent du marché.

4. **Pas de plans de mission récurrents.** Les missions sont manuelles ; les crons vivent hors de QeyNox (chez OpenClaw/Hermes). Or le modèle mental gagnant = **« Programmes »** : chaque stack a des programmes hebdo (veille lun 07:30, signaux mer, rapport lun 08:00) pilotés PAR QeyNox, avec résultats agrégés dans le dossier. Le cockpit devient le chef d'orchestre, pas un bouton.

5. **Les « missions suggérées » du validate ne partent jamais nulle part.** `missions-suggested.json` est un fichier que personne ne consomme automatiquement. Il manque : à la validation, **distribuer automatiquement** les missions aux agents configurés (via webhook sortant / MCP / file de tâches) et tracer qui fait quoi.

6. **Le dossier livre de la stratégie mais pas de munitions.** Il dit « cible ces mots-clés » mais ne livre ni **plans d'articles** (outline par cluster), ni **10 hooks par persona**, ni **battlecards concurrents** (elles sont dans les données !), ni **calendrier éditorial 30 jours**. C'est 1 stage de plus dans le pipeline et cela change tout : le swarm démarre avec des armes, pas avec un plan.

7. **La deep research rate 3 gisements gratuits** : (a) **avis marchands** (Trustpilot/app stores — la mine d'or des verbatims P1, vos requêtes actuelles les frôlent sans les miner systématiquement), (b) **cartographie des canaux** (où vit la niche : subreddits, forums, newsletters, créateurs — requête SearXNG de plus), (c) **pricing pages concurrents** (vous scrapez déjà les prix au passage — structurez-les en tableau comparatif exploitable).

8. **Pas d'AEO « réponses IA »** (signalé, toujours pas fait) : le stage aeo vérifie 11 checks statiques, mais ne demande jamais « quel est le meilleur <catégorie> ? » à ChatGPT/Perplexity pour voir si la marque est citée. C'est le stage qui rendrait QeyNox unique en OSS. Intégration de `geo-optimizer-skill` (MIT, MCP) = 1 journée de travail.

9. **Single-tenant, zéro rôle.** « Admin » est un concept, pas un système. Pour vendre : auth (Authentik devant suffira), rôles admin/analyst/**client-viewer** (lien read-only par stack = le mode agency : le client VOIT son dossier et son suivi sans toucher à rien). C'est la fonctionnalité qui transforme un outil interne en business.

10. **Zéro benchmark cross-stacks.** Chaque gtm.db apprend son marché en silo. Le réseau QeyNox (même 5-10 stacks) peut produire « **ce qui convertit dans la niche X** » — un dataset que personne d'autre n'a. Anonymisé, c'est le produit de données le plus défendable du projet (cf. votre research : signaux propriétaires = alpha 2026).

---

## 3. Segments clients pour QeyNox (du plus évident au plus juteux)

| # | Segment | Ce qu'il achète | Prix mentaux | Pourquoi ça marche |
|---|---|---|---|---|
| S1 | **Indie hackers / solopreneurs** (repo GitHub, zéro GTM) | 1 dossier « GTM Launch » + accès cockpit | 290-490 € le dossier ; 39-79 €/mois le suivi | 90 % d'une mission d'agence à 3 000 €, à prix indie ; le self-serve fait le reste |
| S2 | **Micro-agences web/marketing** | QeyNox white-label + multi-stacks (= leur portefeuille clients) | 99-299 €/mois + par stack | Elles vendent du « GTM audit » à 1 500-2 500 € que QeyNox produit en 20 min ; votre marge = leur levier |
| S3 | **Incubateurs / accélérateurs** | Onboarding de cohortes (20-40 startups → 20-40 dossiers + tableau de bord du portefeuille) | 2-8 k€ par cohérence | Ils ont besoin d'évaluer la GTM de leur portfolio ; le pipeline repo→dossier est littéralement une **due diligence GTM automatisée** |
| S4 | **Business angels / fonds early-stage** | Snapshot marché avant investissement (personas, concurrence, demande, AEO de la cible) | 200-500 €/deal | Personne ne fait ça à ce prix ; votre pipeline le fait déjà |
| S5 | **Freelances GTM engineers** (métier qui double d'effectifs/an) | Leur outil de leverage + bibliothèque de programmes | 79-149 €/mois | Ils facturent 600-900 €/jour ; QeyNox multiplie leur sortie |
| S6 | **Écoles de commerce / formations** | Sandbox pédagogique GTM (les étudiants connectent des repos et étudient les dossiers) | licences par promo | Marché de niche mais fidèle et prescripteur |
| S7 | **Les stacks verticaux** (e-com, apps mobiles) | Templates de recherche par verticale + programmes pré-packagés | marketplace 49-199 € | Chaque verticale = un template réutilisable à coût marginal nul |

**Le chemin de vente insider** : S3 et S4 paient cash et sans support (vendeurs de validation), S2 paie récurrent et amène 5-20 stacks chacun (channel), S1 alimente le volume et le bouche-à-oreille (build in public). Commencer par 3 ventes manuelles S1/S3 pour prouver le prix.

---

## 4. Approches & business models auxquels vous n'avez pas pensé

### 4.1 Open core à l'envers (le « engine-first »)
Publiez en OSS **uniquement le moteur** (`engine/repo_scan.py` + `engine/research.py` + les tools/) : « *le pipeline qui transforme un repo en dossier GTM* » — c'est un projet GitHub à fort potentiel de stars (l'audience agents/GTM-engineer est la plus explosive de 2026 : Hermes 150k★, OpenClaw 370k★, Dify 154k★). Reste privé : le cockpit multi-stacks, les rôles, les benchmarks, les programmes. **L'OSS amène la distribution, le SaaS/la licence amène l'argent.** Bonus : chaque star = un lead chaud du segment S5.

### 4.2 Le serveur MCP comme produit d'appel
« *QeyNox MCP : votre base GTM accessible à tous vos agents* » — 150 lignes (FastMCP stdlib-friendly) exposant keywords/signals/dossier/missions. C'est le trojan horse parfait : les utilisateurs d'agents l'installent pour l'utilité immédiate, puis découvrent le cockpit. Et ça colle au nom du vent : tout le marché des outils 2026 devient MCP-first (Postiz a ajouté un Agent CLI, Firecrawl un serveur MCP, etc.).

### 4.3 « GTM-as-a-Service » (le fulfilment vendu)
Vous ne vendez pas l'outil aux buyers pressés : vous vendez le **résultat + la machine qui continue**. Offre : « Dossier + 90 jours de swarm » à 1 200-2 400 €/mois. Votre coût réel : ~2-3 h/sem de QA/validation (le checkpoint humain — votre temps est la seule ressource rare, et elle est déjà architecturée dans le produit).

### 4.4 Le registre QeyNox (le jeu de données)
Chaque run enrichit les bases par stack. À 20-50 stacks actifs, vous avez un tableau que personne n'a : *« pour la niche X, ces intentions reviennent dans 70 % des dossiers ; ces mots-clés sont sous-exploités ; ces concurrents changent de pricing tous les 45 jours »*. Anonymisé et agrégé = (a) argument de vente imbattable, (b) futur produit data (benchmark API), (c) moat temporel irréductible — on peut copier votre code en un week-end, pas votre historique.

### 4.5 Le template marketplace (communauté)
Chaque vertical playbook (recherches + programmes + critères AEO spécifiques) est un fichier. Laisser la communauté en publier (revshare 70/30) = catalogue qui grossit sans vous + lock-in des contributeurs. Modèle éprouvé (ClawHub : 44 000 skills ; skills Hermes auto-générés).

### 4.6 La certification « QeyNox Operator »
Quand S5 grossit : formation + certification (200-500 €) pour les freelances qui vendent des dossiers avec votre moteur. C'est le modèle Clay (Clay University → écosystème d'agences certifiées) transposé en OSS GTM. Revenue + prescripteurs + standard de fait.

---

## 5. Roadmap opportuniste (impact/effort, ordonnée pour un solo)

| Vague | Quoi | Effort | Pourquoi maintenant |
|---|---|---|---|
| **V1 (1-2 sem)** | Stage **LLM synthèse** (Ollama/LiteLLM) → personas clusterisés + executive summary · **Dossier v2 avec munitions** (5 outlines d'articles + 10 hooks/persona + battlecards depuis les données déjà collectées) | Moyen | C'est le saut de prix 50 € → 400 € du dossier ; tout le reste en découle |
| **V2 (sem 3-4)** | **MCP server** QeyNox · **Programmes récurrents** (cron intégré au cockpit) · hooks sortants vers Hermes/OpenClaw (auto-dispatch des missions suggérées) | Moyen | Le swarm devient un vrai circuit fermé ; distribution MCP |
| **V3 (mois 2)** | **Webhook re-scan** (GitHub App léger) + timeline/diff des dossiers · **stage AEO réponses IA** (geo-optimizer-skill) · lien client read-only par stack | Moyen+ | Boucle vivante + mode agency |
| **V4 (mois 2-3)** | OSS du moteur + build in public · page de vente du dossier produitisé · 3 ventes manuelles · **Authentik + rôles** | Faible/moyen | Distribution + premières recettes réelles |
| **V5 (mois 3+)** | Registre/benchmarks cross-stacks · marketplace de templates verticaux · offre incubateurs (S3) | Moyen | Le moat data se constitue tout seul en arrière-plan |

**Règle de priorisation** : chaque fonctionnalité doit rapprocher l'une de ces 3 métriques — (1) prix du dossier, (2) nombre de stacks actifs, (3) profondeur du graphe de marché. Tout le reste attend.

---

## 6. Les paris risqués que l'insider assumerait (mais vous ne lirez pas ailleurs)

1. **Le pivot « due diligence GTM » pour investisseurs (S4)** est peut-être le segment le plus rentable par heure vendue : les angels paient 300-500 € sans négociation pour réduire une erreur d'investissement à 25 k€. Votre pipeline le produit en 20 min. Personne ne se bat sur ce créneau, et le nom « QeyNox Due Diligence » suffit.
2. **La concurrence réelle n'est pas Clay & co** — c'est le « gpt-wrapper qui fait des rapports GTM » à 29 €/mois. Votre défense : (a) le checkpoint humain, (b) l'historique par stack, (c) les programmes récurrents, (d) la souveraineté self-host. Ne vous comparez jamais sur « la qualité du PDF ».
3. **Le plus grand risque opérationnel est le scraping** (vous l'avez vu : DDG 202, Mojeek 403, Bing bruité). La réponse n'est pas plus de fallbacks : c'est **SearXNG bundlé** (`docker compose --profile full up` démarre QeyNox + SearXNG ensemble) + option SERP API payante en config. La fiabilité du moteur EST la qualité produit.
4. **Le nom des choses vend** : « pipeline », « stack », « mission », « swarm » = vocabulaire d'ingénieur. Pour vendre : « Dossier GTM », « Programmes de croissance », « Agents de production », « Portefeuille ». Même produit, autre étiquette, autre prix.
5. **Documentez publiquement la construction** (les bugs que vous avez vus : signatures qui dérivent, fallbacks bruités, écrasements d'éditions) — c'est du contenu en or pour l'audience GTM-engineer, et le build in public est votre canal d'acquisition le moins cher. Chaque correction système = un post.

---

## 7. Le résumé de l'insider en 5 lignes

QeyNox est déjà une agence industrialisée déguisée en outil interne. Le chemin le plus court vers l'argent : **ajouter la couche LLM au dossier (V1) → brancher le circuit fermé MCP/programmes (V2) → vendre 3 dossiers manuellement à 400 € (V4) → laisser l'OSS du moteur faire la distribution → construire le registre en arrière-plan**. L'actif défendable n'est pas le code (copiable en un week-end), c'est l'historique des marchés + le checkpoint humain + la distribution agents. Et le marché qui paie le plus par heure n'est pas celui que vous visez : ce sont les incubateurs et les investisseurs.
