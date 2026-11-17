# Flow 2.0 — revue de direction artistique

Verdict : **À AMÉLIORER**. La structure est fiable et professionnelle ; elle ne donne pas encore une signature de studio agentique haut de gamme. Référence auditée : `773d11a21901d40a25a05c8268ae83f0023d5a3a`. Recommandations, pas implémentation.

## Périmètre et preuves

- Audit navigateur du 2026-11-17 : les trois états ont été observés aux trois tailles demandées sur fixtures locales isolées, soit neuf combinaisons. Les captures de cette session ont été affichées mais n'ont pas pu être enregistrées par l'outil navigateur ; elles ne sont pas archivées. Les fixtures ne sont pas des preuves client ; celles de RUNNING et RESULT conservent un texte Pilot d'approbation incohérent, défaut du jeu d'essai non attribuable au produit réel.
- Les cinq PNG fournis dans `docs/flow/evidence/` documentent uniquement **WAITING_APPROVAL** aux trois tailles, un détail desktop et l'inspecteur mobile ; ils ne constituent pas une archive visuelle complète des neuf vues observées.
- `flow2-desktop-1440x900.png` : en-tête de mission ample ; approbation claire dès le premier écran. Le canvas « current work » et les capacités actives sont repoussés plus bas, derrière un inspecteur très présent.
- `flow2-desktop-detail-1440x900.png` : la décision est répétée dans le canvas alors que l'inspecteur montre surtout contexte Soul et disponibilité technique ; les capacités démarrent sous le pli. Le regard perçoit des cartes indépendantes, pas une collaboration.
- `flow2-tablet-1024x768.png` : barre latérale 240 px et en-tête haut consomment l'espace ; le rail en quatre colonnes précède le travail et l'action d'inspection flotte sur le contenu.
- `flow2-mobile-390x844.png` : environ 630 px sont pris avant le rail ; la décision et le travail sont hors du premier écran, une phase est coupée, et le bouton fixe de l'inspecteur recouvre le bas du contenu.
- `flow2-mobile-inspector-390x844.png` : tiroir lisible mais long, avec contexte général et état des lectures avant toute sélection ; des détails techniques concurrencent l'objet métier.
- Navigateur, RUNNING : à 1440 la tâche active est visible mais agents et événements sont sous le pli ; à 1024 et 390, en-tête et rail précèdent le travail. RESULT : à 1440 titre et lien du document sont visibles, mais constatations et limites ne sont pas mises en avant et la note de statut se répète ; à 1024 et 390 le résultat est sous le pli. WAITING_APPROVAL : formulaire visible à 1440, sous le pli à 1024 et 390.
- Navigateur, RESULT mobile : l'ouverture de l'inspecteur place le focus sur Fermer ; Échap ferme et rend le focus au bouton d'ouverture. Cela ne valide pas le lecteur d'écran ni le retour au déclencheur après sélection d'un autre objet.
- Les cinq captures conservées ne suffisent pas pour juger les neuf combinaisons ni le mouvement, l'ordre de focus, le clavier, le contraste réel, le lecteur d'écran et les erreurs. Les neuf observations navigateur complètent le diagnostic sans remplacer ces contrôles. La référence visuelle approuvée est absente : comparaison **BLOCKED**. Toute fixture doit être signalée comme telle.

## Diagnostic graphique

1. **Signature faible.** Surfaces blanches, bordures et badges similaires composent un tableau de gestion classique ; le mince trait bleu ne suffit pas à exprimer un atelier où un résultat prend forme.
2. **Collaboration invisible.** `AgentActivity` existe, mais son placement après l'inspecteur et sous le pli rend les capacités et leurs tâches difficiles à relier au travail actuel. Les noms et la simultanéité restent strictement ceux des tentatives enregistrées.
3. **Priorité dupliquée.** La carte d'approbation puis le canvas répètent le même blocage ; l'utilisateur comprend la décision, mais perd la vue d'ensemble, les éléments de preuve et les étapes liées.
4. **Progression peu incarnée.** Le rail signale des phases mais coupe les titres d'étapes ; il décrit la structure davantage que ce qui change. Événements et constats sont séparés de l'objet qu'ils éclairent.
5. **Inspecteur trop général.** Par défaut, il occupe une colonne entière avec des contrôles de disponibilité ; il devrait donner d'abord la provenance et les actions de l'objet choisi. Son volet compact ne déclare pas `role="dialog"` / `aria-modal` dans les composants examinés : risque à vérifier au lecteur d'écran.
6. **Mobile dispersé.** Deux barres de navigation, en-tête riche, rail horizontal puis cartes éloignent la décision. Le grand bouton fixe concurrence le CTA et peut couvrir le dernier élément visible.
7. **Qualité des détails.** La palette navy/cobalt, les marges, la distinction ambre et le texte de statut sont une bonne base. Les métadonnées très petites et les codes bruts exposés sans hiérarchie réduisent le confort et l'impression premium.

## Composition cible — Professional Blue 2.0

- **Idée directrice : atelier de résultats.** Un canvas clair, structuré autour d'un objet de travail réel ; cobalt réservé à l'activité confirmée et à l'action principale, ambre aux décisions, vert uniquement aux états confirmés. Pas de néon violet, de robot décoratif, de faux graphe ni d'indicateur fictif.
- **1440 × 900 :** conserver navigation 272 px et marges 32–40 px. Dans l'espace restant, grille indicative `160–184 px / minmax(440 px, 1fr) / 280–320 px`, écarts 16–20 px. En-tête condensé cible 140–180 px selon texte ; laisser au moins un aperçu du canvas et de la décision en haut. Les tailles s'adaptent au contenu, jamais de hauteur qui coupe les textes.
- **Centre :** une surface principale 16–22 px de rayon, avec état, tâche actuelle, capacité réelle, progression mesurée si disponible et dernier événement pertinent. Regrouper visuellement les contributions simultanées réelles par cartes compactes alignées avec leurs étapes ; aucune ligne de collaboration sans relation documentée.
- **Droite :** inspecteur 280–320 px, titre de la sélection, état et provenance d'abord, preuve/limites puis actions disponibles. En l'absence de sélection, résumé court et invitation ; replier les disponibilités techniques sous « détails » sans les effacer.
- **1024 × 768 :** navigation 240 px, canvas en une colonne ; rail résumé compact au-dessus ou à côté selon place, inspecteur à la demande. Mettre la décision ou le travail actuel avant le rail détaillé ; pas de double défilement horizontal.
- **390 × 844 :** marges 16 px, navigation condensée, titre et statut puis décision ou travail actuel avant le plan. Rail empilé ou résumé avec accès à toutes les étapes ; titres complets accessibles. Déclencheur d'inspecteur dans le contexte ou barre basse réservant son espace ; ne masque ni contenu ni CTA. Tiroir plein écran utilisable et refermable.
- Typographie : titre 26–28 px mobile et 30–34 px desktop, texte principal 14–16 px, métadonnées 12–13 px ; contraste AA, expansion FR/EN 30 %, pas d'information critique ellipsée. Réutiliser uniquement les tokens sémantiques et espacements 8 px du système.

## Trois états à rendre distincts

- **RUNNING :** tâche et capacité réellement actives au premier plan, tentatives enregistrées et progression mesurée ; une chronologie courte relie les derniers événements à l'activité sans présumer d'un acteur. Si aucune tentative lisible, afficher l'incertitude, pas une équipe simulée.
- **WAITING_APPROVAL :** une seule carte décisionnelle prioritaire avec objet, échéance, contexte connu, confirmation et actions autorisées ; le canvas garde visible la tâche bloquée et le retour aux preuves. Une approbation absente, expirée ou périmée reste bloquée.
- **RESULT :** document réel au centre avec titre, version, statut, constats, sources et limites ; montrer la formation du résultat par les éléments effectivement enregistrés, et une action de lecture/export seulement si disponible. `COMPLETED` ne garantit ni document ni réussite métier.

## Motion design

- Entrée d'un événement confirmé : repère cobalt et léger fondu 180–240 ms, puis état statique ; aucun mouvement au chargement initial, à la pagination ou sur historique. Après reconnexion, animer seulement une séquence nouvelle effectivement établie ; sinon rester statique.
- Volet : transition 180–220 ms avec `--qx-ease`, pas de rebond ; feedback d'action 120–180 ms. Pas de pulsation continue, particules, faux flux, progression sur minuterie ou animation de succès avant confirmation serveur.
- `prefers-reduced-motion: reduce` : affichage final immédiat, sans déplacement ; conserver libellés, indicateurs statiques et annonces utiles. Préserver focus et sélection lors des rafraîchissements.
- Constat code : `event-timeline.tsx` signale actuellement 1 200 ms et compare le premier `eventId` de la page ; une pagination pourrait signaler un événement historique. Risque statique à confirmer par interaction. `FLOW2_STATUS.md` décrit 120–220 ms : ne pas confondre cette indication avec le signal effectivement codé.
- Motion/TLS : le CSS natif existant couvre le besoin sans dépendance. L'ancien échec TLS est documenté sans cause établie ; la vérification actuelle du registre échoue en DNS (`ENOTFOUND`) dans cet environnement. Si Motion devient indispensable dans un lot autorisé, diagnostiquer DNS/proxy puis chaîne de certificats fiable, rétablir l'accès, installer et vérifier lockfile/build ; ne pas désactiver TLS.

## Priorités pour DeepSeek

| Priorité | Correction | Fichiers exacts à examiner |
|---|---|---|
| P0 | Décision et tâche en premier écran mobile ; aucun bouton fixe ne masque contenu/CTA, titres critiques entiers. | `apps/web/src/components/flow/flow-workspace.tsx`, `flow-header.tsx`, `phase-rail.tsx`, `apps/web/src/app/globals.css` |
| P0 | Inspecteur modal : nom, rôle/modalité, focus initial, piégeage, Échap et retour au déclencheur réel ; vérifier navigateur/lecteur d'écran. | `apps/web/src/components/flow/flow-workspace.tsx`, `context-inspector.tsx`, `apps/web/src/app/globals.css` |
| P1 | Transformer le canvas en espace de travail : capacités et étapes réelles visibles ensemble ; supprimer la duplication de la décision sans supprimer confirmation ni contexte. | `apps/web/src/components/flow/now-canvas.tsx`, `agent-activity.tsx`, `flow-workspace.tsx`, `apps/web/src/app/globals.css` |
| P1 | Résultat lisible dès son apparition : statut propre, preuves, limites, accès au document ; réduire la place des métadonnées techniques. | `apps/web/src/components/flow/now-canvas.tsx`, `context-inspector.tsx`, `apps/web/src/app/[lang]/missions/[id]/results/[documentId]/page.tsx`, `apps/web/src/app/globals.css` |
| P1 | Événements hiérarchisés par pertinence réelle et animation réservée aux nouveaux événements confirmés ; aucun faux temps réel. | `apps/web/src/components/flow/event-timeline.tsx`, `event-label.ts`, `apps/web/src/lib/flow-model.ts`, `apps/web/src/app/globals.css` |
| P2 | Affiner échelle typographique, rythme, bordures et état vide de l'inspecteur ; traductions EN/FR extensibles. | `apps/web/src/components/flow/context-inspector.tsx`, `apps/web/src/lib/flow-copy.ts`, `apps/web/src/app/globals.css` |

## Contrôles d'acceptation

- Capturer **3 états × 3 tailles** (`1440×900`, `1024×768`, `390×844`) en navigateur sur fixtures identifiées, et inspecter chaque capture : tâche/décision/résultat réellement présents, aucun contenu masqué, aucune donnée inventée.
- Au premier écran, l'objectif, le statut et la priorité du moment doivent être compréhensibles sans chercher dans l'inspecteur ; sur mobile, l'action prioritaire et son contexte ne doivent pas être cachés par un contrôle fixe.
- Tester clavier, focus restauré au vrai déclencheur, nom/role/modalité, contraste AA mesuré, zoom/texte agrandi et `prefers-reduced-motion` activé ; vérifier l'absence de débordement global et l'accès à tous les éléments du rail.
- Vérifier l'arrivée d'un événement, la pagination, le retour d'onglet et la reconnexion : animation unique seulement si nouveauté confirmée, aucun statut ni chiffre simulé. Tester états vides, refus, erreur, périmé et approbation expirée.
- Conserver isolation, consentement, permissions, révisions et source de vérité ; les actions restent soumises aux contrôles serveur. Aucun PASS de conformité ou de fidélité visuelle sans preuve correspondante.

## Smoke capabilities — diagnostic hors lot

`apps/web/scripts/smoke.mjs` attend « Availability cannot be confirmed » sur `/en/capabilities` sans cookie. La page concernée privilégie désormais l'invitation à se connecter lorsque la session manque ; les fichiers sont identiques à la baseline `e14d172`. `FLOW2_STATUS.md` rapporte une reproduction sur cette baseline. Relance actuelle **BLOCKED avant l'assertion** par l'environnement local, donc pas de nouvelle reproduction dynamique. Dans un lot dédié, aligner le test anonyme sur le comportement réel et couvrir séparément le catalogue authentifié ; ne pas contourner l'authentification.
