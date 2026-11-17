# Flow — certification locale du transport, 2026-11-17

Base du candidat : `f57fbd326b1182dadacd3560af0a140d97582749`. PostgreSQL 16 jetable sur loopback, base QA créée puis supprimée ; aucune base distante. NestJS réel, worker QeyNox distinct avec polling de projection, Next.js build production et Chrome Playwright. Le worker n'a pas de token Hatchet : aucun runtime externe n'est simulé. Le test principal ne fait aucun appel à `projectOnce()`.

Commande principale : configurer `QEYNOX_QA_DATABASE_URL` avec une URL PostgreSQL **locale jetable**, `QEYNOX_QA_PLAYWRIGHT_PATH` vers le module Playwright local et `QEYNOX_QA_BROWSER` vers Chrome, puis exécuter `pnpm --filter @qeynox/api exec tsx scripts/qa-sse-bff.ts`. Les valeurs et sessions ne sont pas consignées ici.

Sortie expurgée, code 0 :

```text
Flow browser QA PASSED: mission, eventless update, fallback/reconnect, EN/FR, mobile and reduced motion
SSE HTTP QA PASSED: auth, workspace, real projection, replay and secret exclusion
```

Assertions exécutées : connexion QA, opération réelle, événements et résultat persistés, projection autonome du worker, SSE et relecture Flow, changement sans événement, phase et résultat, brouillon et focus conservés, coupure/fallback/reconnexion, séquence sans doublon, absence d'animation sur replay et une animation sur événement neuf, changement de workspace, révocation sur flux, isolation, absence de bearer dans HTML/SSE, mobile et desktop EN/FR, reduced-motion. Le résultat et la capacité sont des fixtures QA, pas des preuves métier.

Autres commandes exécutées : `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`, `pnpm qa:task02` (3336 assertions), `pnpm qa:backend` (28), `pnpm qa:projection-migration`, `pnpm qa:projection-http`, `pnpm qa:projection-worker`, `pnpm --filter @qeynox/web test:flow2` (35), `pnpm --filter @qeynox/web test:smoke` (91) : PASS. La migration couvre historique peuplé, curseurs et rollback sur corruption ; le test HTTP impose une session PostgreSQL read-only.

NOT_RUN : Hatchet/Hermes réels, fournisseurs externes pour une mission et déploiement. La migration d'une base distante peuplée, le runbook d'exploitation et la certification de production restent des gates distinctes. Le screenshot de référence approuvé est absent : comparaison visuelle NOT_RUN.
