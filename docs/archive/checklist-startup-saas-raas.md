# 🚀 Checklist startup — QeyNox en SaaS / RaaS
## « Qu'ai-je oublié pour en faire une startup ? » — audit complet · octobre 2026

> **Verdict en une phrase** : le produit est à ~70 % d'un SaaS vendable (moteur e2e testé, boucles, MCP, LLM, garde-fous, pricing théorisé) — mais une startup n'est pas un produit. Il manque **7 briques hors-produit**, dont une bloque tout le reste.

---

## 1. État des lieux — ce qui est DÉJÀ prêt (plus que la plupart des projets)

| Brique | État | Où |
|---|---|---|
| Moteur e2e repo → analyse → research → dossier | ✅ testé (oracle-lumira : 381 kw, AEO 90/100) | `engine/` |
| Boucles L2/L3/L5 + garde-fous (timeouts, plafonds, kill switch, retries) | ✅ daemon actif, 1er cycle réel OK | `engine/loops.py` |
| LLM synthèse (Ollama/openai-compat, skip propre) | ✅ | `engine/synthesize.py` |
| MCP serveur (distribution agents) | ✅ 10 outils testés | `mcp_server.py` |
| UI web single-user | ✅ :8765 | `web/` |
| Pricing & segments (S1-S7), 6 business models | ✅ théorisé | `insider-opportunites-qeynox.md` |
| Stack outils OSS / self-hosted | ✅ | `oraclelumira-gtm/besoins-outils-par-departement.md` |
| Moat produit (gtm.db = capital, graphe de marché historique) | ✅ identifié | idem |

---

## 2. Les 7 oublis qui tuent — par ordre de priorité absolue

### 🔴 Oubli n°1 — Vous n'avez encore vendu RIEN (le seul qui compte vraiment)
Tout le reste de cette liste est secondaire face à ça. Le risque n°1 de QeyNox n'est pas technique, c'est **6 mois d'ingénierie de plus avant le premier euro**. Le doc insider disait « V4 : 3 ventes manuelles » — **c'est trop tard, inversez** : vendez les 3 premiers dossiers CETTE SEMNAINE, à la main, avec le moteur actuel :
- 3 stacks amis/connus (S1 indie 290-490 € ou S4 angels 200-500 €) payés d'avance.
- Ce que vous achetez en échange : le **vocabulaire d'achat** (« qu'est-ce qui a déclenché l'achat ? qu'est-ce qui a failli faire échouer la vente ? »), les 3 objections récurrentes, et la preuve que le dossier vaut un prix.
- Un SaaS sans pré-vente est un hobby avec des serveurs.

### 🔴 Oubli n°2 — Vous ne connaissez pas votre coût de revient par dossier
Vous ne pouvez pas fixer un prix ni une marge si vous ne savez pas ce que coûte UN run : tokens LLM (synthèse), requêtes search, minutes de compute, temps humain de validation. **À instrumenter avant toute vente** :
- compteur tokens + € par stage (la table `traces` de l'audit obs. — à faire en 1 journée) ;
- objectif connu dès le 1er dossier : *coût variable < 10 % du prix* (dossier à 390 € → coût cible < 39 €) ;
- le RaaS récurrent (99-299 €/mois) ne survit que si le coût mensuel d'un stack suivi < 30 €.

### 🔴 Oubli n°3 — Les paiements depuis votre situation (le piège invisible)
Vous êtes au **Maroc** : **Stripe n'y est pas disponible en mode compte standard.** Vous aviez déjà identifié le risque MCC 7995 pour Lumira — c'est le même mur, en pire pour un SaaS. Options concrètes :
- **Merchant of Record (recommandé pour démarrer)** : **Paddle** ou **Lemon Squeezy** — ils encaissent en leur nom, gèrent la TVA/UE, vous versent par Wise/Payoneer. Zéro entité française nécessaire au début, facturation B2B propre.
- **PayPal Business Maroc** : fonctionne, mais fragile (gels de fonds — vous le savez déjà avec Lumira).
- Plus tard (traction) : entité adaptée (SARL Maroc pour les coûts, ou structure à Dubaï/Estonie si la clientèle devient UE/US — à arbitrer avec un comptable, pas seul).
- ⚠️ À vérifier cette semaine, car ça conditionne le modèle entier : sans encaissement fiable, pas de SaaS self-serve → modèle « deals manuels + MoR » d'abord.

### 🟠 Oubli n°4 — Le saut local → multi-tenant (le vrai chantier SaaS)
QeyNox tourne en single-user sur votre machine. Un SaaS, c'est :
- **Comptes & rôles** : auth (magin link email suffit au début), rôles `owner` / `client-viewer` (le client voit SON stack, jamais les autres — déjà flaggé dans l'insider doc) ;
- **Isolation par tenant** : les stacks déjà cloisonnés par dossier = bonne base ; il manque auth devant + quota par plan ;
- **Hébergement** : Docker image du stack complet (moteur + web + SearXNG + Ollama optionnel) → un VPS EU (Hetzner/Scaleway, ~20-40 €/mois pour 10 clients) ;
- **Backups chiffrés** + **status page** (les clients d'un produit agentique veulent VOIRE que ça tourne — UPPTIME ou simple page statique) ;
- **Exécution durable** (audit V2) : devient CRITIQUE en SaaS — un run mort au stage 5 = ticket support + remboursement.
> Estimation honnête : 3-4 semaines de travail. **À ne faire qu'après 5 clients manuels** (Oubli n°1).

### 🟠 Oubli n°5 — La sécurité des secrets clients (le bloqueur de vente B2B)
Vos clients vous donneront des **jetons GitHub / accès à leurs repos**. Le jour 1, pas le jour 100 :
- secrets chiffrés au repos (jamais en clair dans `stacks/`), jamais dans les logs ;
- les spawns d'outils (`launch_tool`, loops) tournent sans réseau sortant libre (sandbox) ;
- audit log : qui a lancé quoi, quand — un fichier JSONL suffit au début ;
- pas de SOC2 avant que quelqu'un le demande par écrit — mais **un paragraphe « sécurité » crédible sur la landing dès le jour 1**.

### 🟠 Oubli n°6 — Le juridique minimum (une semaine, pas plus)
- **CGV/CGU + politique de confidentialité** (générateurs + relecture) — qui possède les données ? Réponse à graver : *le client possède son gtm.db et ses dossiers, QeyNox n'en garde que des métriques agrégées* ;
- **DPA** (traitement de données pour le compte du client) — requis dès le premier client UE ;
- **Licence de QeyNox lui-même** : si open core (recommandé), choisir MAINTENANT — AGPL-3.0 pour le cœur (empêche un concurrent de le fermer), Apache-2.0 si vous voulez maximiser l'adoption (risque de fork concurrent) ;
- **Scraping** : `competitor_watch` scanne les sites concurrents — basique, public, à faible volume = risque faible, mais à mentionner dans les CGU (« données publiques ») ;
- RGPD : les verbatims sociaux peuvent contenir des données personnelles → Presidio (déjà dans l'audit) + droit à l'effacement = `DELETE FROM stacks/<slug>`.

### 🟡 Oubli n°7 — La vitrine de vente (2 jours, pas 2 mois)
Il n'existe pas un seul pixel qui explique QeyNox à un acheteur :
- **Landing** (1 page) : le Before/After (« votre repo ce matin → votre dossier GTM ce soir »), 1 démo GIF, prix des dossiers, bouton Paddle ;
- **Un dossier d'exemple public** (oracle-lumira anonymisé ou fictif) — c'est votre produit, il doit être visible ;
- **Nom de domaine + email pro** (qeynox.com probablement pris → qeynox.ai / getqeynox.com) ;
- 2-3 études de cas après les premières ventes (Oubli n°1).

---

## 3. Le spécifique RaaS — vendre des RÉSULTATS change 3 choses

Si vous vendez le dossier (RaaS) et pas l'outil (SaaS) :

1. **La qualité doit être mesurée** → le LLM-juge (L7, audit V2) n'est plus une option : un dossier < 70/100 ne part pas. Le golden set (3-5 stacks de référence) devient votre charte qualité.
2. **Votre temps humain est le goulot** : la validation admin est votre différenciateur MAIS elle rend le business non scalable — c'est exactement pour ça que le pricing RaaS doit être haut (290 €+ le dossier, pas 29 €) et que le SaaS self-serve est la suite logique (le client valide lui-même).
3. **Politique de révision** : « 1 révision incluse, révisions supplémentaires X € » — sinon un client insatisfait mangera vos semaines. À écrire dans les CGV AVANT la première vente.

---

## 4. Ce qu'il ne faut PAS faire maintenant (le piège inverse)

| Tentation | Pourquoi c'est un piège |
|---|---|
| SOC2 / ISO dès le départ | Personne ne l'exige avant ~10 clients B2B sérieux. Coût : 3-6 mois. |
| Marketplace de templates | Vient après le registre (V5 du doc insider). |
| App mobile / i18n / white-label UI | Aucun client payant ne l'a demandé. Personne ne le demandera avant d'avoir payé. |
| k8s, autoscaling, microservices | Un VPS fait tourner 10-50 clients. Votre moat = les données, pas l'infra. |
| Lever des fonds maintenant | Sans 3 ventes, vous levez sur des slides. Avec 3 ventes, vous négociez. |
| Parfaitement finir V2/V3 du moteur | Le moteur est déjà meilleur que ce que 95 % des acheteurs ont. Vendez-le. |

---

## 5. Plan « 30 jours → premier euro »

| Semaine | Actions | Livrable |
|---|---|---|
| **S1** | Compteur de coût/run (traces) · landing 1 page + dossier d'exemple · compte Paddle/Lemon Squeezy · CGV/CGU générateur | Vous pouvez encaisser et expliquer |
| **S2** | **3 pré-ventes manuelles** (réseau X/LinkedIn/communautés indie & angels, dossier à 290-490 €) · livrer les 3 dossiers à la main avec le moteur | **Premier euro + 3 testimonials** |
| **S3** | Étudier les 3 ventes (objections, usage réel du dossier) · ajuster le prix et le dossier · proposer aux 3 clients le passage au récurrent (S2/S5, 99-149 €/mois) | 1-2 récurrents + pricing validé |
| **S4** | Dockeriser le stack → VPS EU · auth minimale + Paddle checkout self-serve pour UN plan seulement (le dossier à l'unité) | SaaS minimal self-serve |

**North star à suivre dès le jour 1** : dossiers vendus/semaine · coût variable/dossier · time-to-first-dossier (cible < 24 h après commande) · taux de passage au récurrent · rétention M3.

---

## 6. Réponse directe à la question

**Vous aviez tout prévu côté produit et côté business model — ce que vous aviez oublié, c'est tout ce qui n'est ni du code ni de la théorie :**
1. ❌ **Vendre** (0 client — à corriger cette semaine, avec le moteur actuel) ;
2. ❌ **Coût de revient par dossier** (sans lui, pas de marge, pas de prix) ;
3. ❌ **Encaissement depuis le Maroc** (Stripe indisponible → Paddle/Lemon Squeezy/MoR — le mur invisible) ;
4. ❌ **Multi-tenant + auth** (le vrai chantier SaaS, après les 5 premiers clients) ;
5. ❌ **Secrets clients & audit log** (le bloqueur des ventes B2B, jour 1) ;
6. ❌ **Juridique minimum** (CGV, DPA, licence du cœur, propriété des données) ;
7. ❌ **Vitrine** (landing, dossier d'exemple public, domaine — 2 jours suffisent).

Le reste de votre feuille de route (V2 client MCP + LLM-juge + durable, V3 Graphiti) est juste et garde son ordre — mais tout cela sert le produit, et **seule la vente valide la startup**.
