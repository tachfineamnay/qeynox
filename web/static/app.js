/* QeyNox — GTM Swarm Platform · application front (vanilla JS, zéro dépendance) */
"use strict";

/* ---------------------------------------------------------------- icônes */
const I = {
  layers:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/><path d="m3 17.5 9 5 9-5" opacity=".45"/></svg>',
  home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/></svg>',
  keywords:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.9-4.9"/></svg>',
  pulse:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6 4 12L16 12h5"/></svg>',
  radar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><path d="M12 12l6-6.5"/></svg>',
  chart:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20V4"/><path d="M4 20h16"/><path d="m7 14 4-5 3 3 5-7"/></svg>',
  rocket:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15c-2-.5-3.5-2-4-4 1-4.5 4.5-8 9.5-8.5C18 7.5 14.5 11 10 12"/><path d="M8 11c-2 .3-3.5 2-4 5 3-.5 4.7-2 5-4"/><path d="M13 16c-.5 2-2 3.5-5 4 .5-3 2-4.5 4-5"/><circle cx="14.5" cy="9.5" r="1.3"/></svg>',
  doc:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5h8L19 8v13.5H6z"/><path d="M13.5 2.5V8H19"/><path d="M9 12h6M9 15.5h6"/></svg>',
  users:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c.6-3.6 3-5.6 6.2-5.6s5.6 2 6.2 5.6"/><circle cx="17.5" cy="9" r="2.6"/><path d="M16.4 14.6c2.7.2 4.4 2 4.9 4.9"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  refresh:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5v6h-6"/></svg>',
  x:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.9-4.9"/></svg>',
  trend:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 16 5.5-5.5 3.5 3.5L20 6"/><path d="M15 6h5v5"/></svg>',
  warn:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19z"/><path d="M12 9.5V14"/><circle cx="12" cy="17" r=".4" fill="currentColor"/></svg>',
  arrow:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6"/></svg>',
  ext:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 14v6H4V5h6"/></svg>',
  csv:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 2.5h8L19 8v13.5H6z"/><path d="M13.5 2.5V8H19"/><path d="M9 13h6M9 16.5h6"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
  repo:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m7 3-4 3v15l4-3 4 3 4-3 4 3V6l-4-3-4 3-4-3Z"/><path d="M7 3v15M11 6v15M15 3v15M19 6v15" opacity=".4"/></svg>',
  moon:'<svg viewBox="0 0 48 48"><path d="M24 5 40 14.5v19L24 43 8 33.5v-19Z" fill="none" stroke="#C4A35A" stroke-width="1.6"/><path d="M24 12.5 32.5 17.5v10L24 32.5 15.5 27.5v-10Z" fill="#C4A35A" opacity=".85"/></svg>'
};

/* ---------------------------------------------------------------- helpers */
const $ = (s, el=document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const nf = n => new Intl.NumberFormat("fr-FR").format(n ?? 0);
const INTENTS = [["","Toutes"],["commercial","Commercial"],["info","Info"],["transactional","Transactionnel"],["brand","Marque"],["?","À qualifier"]];
const AGENT_META = {goc:{n:"GOC",e:"🧭"},scout:{n:"SCOUT",e:"🔎"},scribe:{n:"SCRIBE",e:"✍️"},signal:{n:"SIGNAL",e:"📣"},pilot:{n:"PILOT",e:"📊"}};
const STAGE_ICON = {done:"✓", running:"◐", error:"✕", skipped:"–", pending:"·"};

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) { let m; try { m = (await r.json()).error; } catch {} throw new Error(m || `HTTP ${r.status}`); }
  return r.json();
}
function rel(iso) {
  if (!iso) return "—";
  const d = new Date(iso); if (isNaN(d)) return iso;
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s/60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s/3600)} h`;
  return `il y a ${Math.floor(s/86400)} j`;
}
function toast(title, sub="", type="") {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.innerHTML = `<div class="t-title">${esc(title)}</div>${sub ? `<div class="t-sub">${esc(sub)}</div>` : ""}`;
  $("#toast-root").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = ".4s"; setTimeout(() => t.remove(), 420); }, 5000);
}
function md(src) {
  const codeBlocks = [];
  src = src.replace(/```([\s\S]*?)```/g, (_, c) => { codeBlocks.push(c); return `\u0000${codeBlocks.length-1}\u0000`; });
  let h = esc(src);
  h = h.replace(/^### (.*)$/gm,"<h3>$1</h3>").replace(/^## (.*)$/gm,"<h2>$1</h2>").replace(/^# (.*)$/gm,"<h1>$1</h1>")
       .replace(/^---+$/gm,"<hr>").replace(/^&gt; (.*)$/gm,"<blockquote>$1</blockquote>");
  h = h.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>").replace(/`([^`]+)`/g,"<code>$1</code>");
  h = h.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/^- \[ \] (.*)$/gm,'<li class="cbx">☐ $1</li>').replace(/^- \[x\] (.*)$/gim,'<li class="cbx">☑ $1</li>');
  const lines = h.split("\n"); let out = [], inUl = false, inTable = false;
  const closeUl = () => { if (inUl) { out.push("</ul>"); inUl = false; } };
  const closeTb = () => { if (inTable) { out.push("</tbody></table></div>"); inTable = false; } };
  for (const ln of lines) {
    const t = ln.trim();
    if (/^[-*] /.test(t) && !/^<li/.test(t)) { closeTb(); if (!inUl) { out.push("<ul>"); inUl = true; } out.push(`<li>${t.slice(2)}</li>`); continue; }
    if (/^<li/.test(t)) { closeTb(); if (!inUl) { out.push("<ul>"); inUl = true; } out.push(t); continue; }
    if (/^\|/.test(t)) {
      closeUl();
      if (/^\|[-\s|:]+\|$/.test(t)) continue;
      if (!inTable) { out.push('<div class="table-wrap"><table><tbody>'); inTable = true; }
      out.push("<tr>" + t.split("|").slice(1,-1).map(c => `<td>${c.trim()}</td>`).join("") + "</tr>"); continue;
    }
    closeUl(); closeTb();
    if (t) out.push(`<p>${t}</p>`);
  }
  closeUl(); closeTb();
  return out.join("\n").replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre>${codeBlocks[+i]}</pre>`);
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ---------------------------------------------------------------- état */
const state = {
  view: "stacks", stack: localStorage.getItem("qx-stack") || "",
  stackSlug: null, intent: "", q: "", openMission: null, pollTimer: null, reportPath: null, showDossier: false,
};
const STACK_VIEWS = new Set(["dashboard","keywords","signals","competitors","serp","missions","reports"]);

const VIEWS = {
  stacks: ["Stacks", "Vos produits connectés — dépôt analysé, dossier GTM, swarm"],
  dashboard: ["Tableau de bord", "Vue d'ensemble du stack sélectionné"],
  keywords:  ["Mots-clés", "Univers de requêtes scoré — socle SEO & hooks"],
  signals:   ["Signaux", "Verbatims réels : forums, Reddit, presse, avis"],
  competitors: ["Concurrents", "Pages surveillées & historique de snapshots"],
  serp:      ["Positions SERP", "Dernière position connue par requête"],
  missions:  ["Missions", "Lancer les outils du swarm et suivre l'exécution"],
  reports:   ["Rapports", "Livrables des agents (markdown & CSV)"],
  agents:    ["Agents", "La flotte GTM : rôles, compétences, activité"],
};

/* ---------------------------------------------------------------- rendu racine */
function setView(v) {
  state.view = v; state.reportPath = null; state.showDossier = false;
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  const [t, s] = VIEWS[v]; $("#view-title").textContent = t; $("#view-sub").textContent = s;
  $("#stack-select-wrap").style.display = STACK_VIEWS.has(v) ? "flex" : "none";
  stopPoll(); render();
}
function stopPoll() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }
function ensurePoll(fn, ms=4000) { stopPoll(); state.pollTimer = setInterval(fn, ms); }
function render() {
  ({stacks: renderStacks, dashboard: renderDashboard, keywords: renderKeywords, signals: renderSignals,
    competitors: renderCompetitors, serp: renderSerp, missions: renderMissions,
    reports: renderReports, agents: renderAgents})[state.view]();
}
function skeleton(n=3) { return Array(n).fill('<div class="skeleton"></div>').join(""); }
function emptyState(title, text, action="") {
  return `<div class="empty"><div class="e-moon">${I.moon}</div><strong>${esc(title)}</strong><p>${text}</p>${action}</div>`;
}
function chipIntent(i) { const label = (INTENTS.find(([v]) => v === i) || [,"?"])[1]; return `<span class="chip ${i==="?"?"unknown":i}">${esc(label)}</span>`; }
function qs() { return state.stack ? `?stack=${encodeURIComponent(state.stack)}` : ""; }

/* ---------------------------------------------------------------- stack selector */
async function refreshStackSelect() {
  const { rows } = await api("/api/stacks");
  const sel = $("#stack-select");
  sel.innerHTML = rows.length
    ? rows.map(s => `<option value="${esc(s.slug)}" ${s.slug === state.stack ? "selected" : ""}>${esc(s.name)}</option>`).join("")
    : `<option value="">— aucun stack —</option>`;
  if (!rows.find(s => s.slug === state.stack)) {
    state.stack = rows[0]?.slug || "";
    localStorage.setItem("qx-stack", state.stack);
  }
  return rows;
}

/* ---------------------------------------------------------------- stacks */
async function renderStacks() {
  const c = $("#content"); c.innerHTML = skeleton(2);
  const { rows } = await api("/api/stacks");
  if (!rows.length) {
    c.innerHTML = emptyState("Aucun stack connecté",
      "Connectez le dépôt d'un produit : QeyNox analyse le projet, en extrait le contexte, mène la deep research (clients, personas, besoins, SEO, AEO/GEO) et produit un dossier GTM que vous validez pour lancer le swarm.",
      `<button class="btn primary" id="onboard-hero">${I.plus} Connecter mon premier dépôt</button>`);
    $("#onboard-hero").addEventListener("click", openOnboardModal);
    return;
  }
  c.innerHTML = `<div class="stacks-grid">${rows.map(s => {
    const d = s.dossier_data || {};
    const stagesHtml = (s.stages || []).map(st =>
      `<span class="stage ${st.status}" title="${esc(st.label)}">${STAGE_ICON[st.status] || "·"} ${esc(st.id)}</span>`).join("");
    const statusLabel = {queued:"en file", running:"analyse en cours", review:"dossier à valider",
                         ready_for_review:"dossier à valider", active:"swarm actif", error:"erreur"}[s.status] || s.status;
    return `
    <div class="card stack-card" data-slug="${esc(s.slug)}">
      <div class="stack-head">
        <div class="agent-emoji">${s.status === "active" ? "🚀" : "⬡"}</div>
        <div style="flex:1;min-width:0">
          <div class="agent-name">${esc(s.name)}</div>
          <div class="rep-path">${esc(s.source || "")}</div>
        </div>
        <span class="chip ${s.status === "active" ? "transactional" : s.status === "error" ? "unknown" : "commercial"}">${esc(statusLabel)}</span>
      </div>
      <div class="stages-line">${stagesHtml}</div>
      ${d.brand ? `<div class="stack-facts">
          <span>${esc(d.brand)}${d.site && d.site !== "—" ? ` · <a href="${esc(d.site)}" target="_blank" rel="noopener">${esc(d.site.replace(/^https?:\/\//,""))}</a>` : ""}</span>
          <span>${nf(d.n_keywords||0)} mots-clés · ${nf(d.n_signals||0)} signaux · ${nf(d.n_competitors||0)} concurrents${d.aeo_score != null ? ` · AEO ${d.aeo_score}/${d.aeo_max}` : ""}</span>
        </div>` : ""}
      <div class="stack-actions">
        <button class="btn subtle" data-open="${esc(s.slug)}">Ouvrir le dossier</button>
        ${s.status === "ready_for_review" || s.status === "review" ? `<button class="btn primary" data-validate="${esc(s.slug)}">${I.check} Valider & lancer</button>` : ""}
        ${s.status === "active" ? `<button class="btn subtle" data-missions="${esc(s.slug)}">Voir le swarm</button>` : ""}
      </div>
    </div>`;
  }).join("")}</div>`;

  c.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => openStackDetail(b.dataset.open)));
  c.querySelectorAll("[data-missions]").forEach(b => b.addEventListener("click", () => { state.stack = b.dataset.missions; localStorage.setItem("qx-stack", state.stack); setView("missions"); }));
  c.querySelectorAll("[data-validate]").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); validateStack(b.dataset.validate, b); }));
  const anyRunning = rows.some(s => s.status === "running" || s.status === "queued");
  if (anyRunning) ensurePoll(async () => { if (state.view === "stacks") renderStacks(); });
}

async function openStackDetail(slug) {
  state.stackSlug = slug; state.showDossier = true;
  const c = $("#content");
  const tmp = state.view; state.view = "stacks"; // réutilise le rendu sans changer la nav
  c.innerHTML = skeleton(2);
  let pipe, dossier;
  try {
    [{ pipeline: pipe }, dossier] = await Promise.all([
      api(`/api/stacks/${slug}/pipeline`),
      api(`/api/stacks/${slug}/dossier`).catch(() => null),
    ]);
  } catch (e) { c.innerHTML = emptyState("Erreur", esc(e.message)); state.view = tmp; return; }
  state.view = tmp;
  const stages = (pipe?.stages || []).map(st => `
    <div class="tl-row">
      <span class="tl-time">${STAGE_ICON[st.status] || "·"}</span>
      <span class="tl-tool">${esc(st.label)}</span>
      <span class="tl-args">${esc((st.log || "").split("\n")[0] || "")}</span>
      <span class="tl-status ${st.status === "done" ? "ok" : st.status === "error" ? "err" : st.status === "running" ? "run" : ""}">${st.status}</span>
    </div>`).join("");
  c.innerHTML = `
    <div class="back-row"><button class="btn subtle" id="back-stacks">${I.arrow ? '<span class="ic">'+I.arrow+'</span>' : ""} Tous les stacks</button>
      <span class="faint small">${esc(slug)}</span></div>
    ${pipe?.status === "running" || pipe?.status === "queued" ? `<div class="banner"><span class="b-ic">${I.radar || I.pulse}</span>
      <div><strong>Analyse en cours.</strong> Le pipeline travaille — cette page se met à jour automatiquement.</div></div>` : ""}
    ${pipe?.status === "error" ? `<div class="banner"><span class="b-ic">${I.warn}</span><div><strong>Pipeline en erreur :</strong> ${esc(pipe.error || "")}</div></div>` : ""}
    <div class="section"><div class="section-head"><h2>Pipeline d'onboarding</h2></div><div class="timeline">${stages || "—"}</div></div>
    ${dossier ? `
    <div class="section">
      <div class="section-head"><h2>Dossier GTM</h2><span class="hint">${esc(dossier.file)}</span></div>
      <div class="validate-bar">
        <label class="cbx-label"><input type="checkbox" id="approve-cbx"> J'ai relu ce dossier et j'approuve le positionnement, les personas et le plan.</label>
        <button class="btn primary" id="btn-launch" disabled>${I.check} Valider & lancer le swarm</button>
      </div>
      <div class="rep-viewer">${md(dossier.content)}</div>
    </div>` : ""}
  `;
  $("#back-stacks").addEventListener("click", () => { state.showDossier = false; renderStacks(); });
  const launchBtn = $("#btn-launch"), cbx = $("#approve-cbx");
  if (launchBtn && cbx) {
    cbx.addEventListener("change", () => launchBtn.disabled = !cbx.checked);
    launchBtn.addEventListener("click", () => validateStack(slug, launchBtn));
  }
  if (pipe?.status === "running") ensurePoll(async () => { if (state.showDossier && state.stackSlug === slug && document.getElementById("back-stacks")) openStackDetailRefresh(slug); });
}
function openStackDetailRefresh(slug) { openStackDetail(slug); }

async function validateStack(slug, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Lancement…"; }
  try {
    const r = await api(`/api/stacks/${slug}/validate`, { method: "POST" });
    toast("Swarm lancé 🚀", `Workspace créé : ${r.files.join(", ")}`, "ok");
    state.showDossier = false;
    await refreshStackSelect();
    renderStacks();
  } catch (e) { toast("Validation impossible", e.message, "err"); if (btn) { btn.disabled = false; } }
}

/* ---------------------------------------------------------------- onboarding modal */
function openOnboardModal() {
  const root = $("#modal-root");
  root.innerHTML = `
  <div class="modal-backdrop" id="mb">
    <div class="modal">
      <div class="modal-head"><h3>Connecter un dépôt</h3><button class="modal-close" id="mclose">${I.x}</button></div>
      <div class="modal-body">
        <div class="field"><label>Nom du projet / produit</label><input id="ob-name" placeholder="ex. Nom du produit"></div>
        <div class="field"><label>Dépôt — chemin local, URL git (https://… .git) ou archive .zip</label>
          <input id="ob-repo" placeholder="/home/user/mon-projet  ·  https://github.com/org/repo.git">
          <div class="f-hint">QeyNox clone/copie le dépôt puis l'analyse localement. Rien n'est envoyé à des tiers.</div></div>
        <div class="field"><label>URL du site public (optionnel — active l'audit AEO/GEO)</label><input id="ob-site" placeholder="https://exemple.com"></div>
        <div class="field"><label>Graines de mots-clés (optionnel — une par ligne)</label>
          <textarea id="ob-seeds" placeholder="mot-clé marché&#10;offre principale"></textarea>
          <div class="f-hint">Sinon QeyNox déduit les graines du contexte extrait du dépôt.</div></div>
        <div class="f-hint" style="margin-top:12px">Pipeline : clonage → analyse stack → mots-clés → signaux → concurrents → audit AEO → dossier GTM (~2-4 min).</div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" id="mcancel">Annuler</button>
        <button class="btn primary" id="ob-launch">${I.repo} Analyser le dépôt</button>
      </div>
    </div>
  </div>`;
  const close = () => { root.innerHTML = ""; };
  $("#mclose").addEventListener("click", close);
  $("#mcancel").addEventListener("click", close);
  $("#mb").addEventListener("click", e => { if (e.target.id === "mb") close(); });
  $("#ob-name").focus();
  $("#ob-launch").addEventListener("click", async () => {
    const name = $("#ob-name").value.trim(), repo = $("#ob-repo").value.trim();
    if (!name || !repo) { toast("Champs requis", "Nom + dépôt obligatoires", "err"); return; }
    try {
      const r = await api("/api/stacks", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, source: repo, site_url: $("#ob-site").value.trim(),
                               seeds: $("#ob-seeds").value.split("\n").map(s => s.trim()).filter(Boolean) }) });
      close();
      toast("Dépôt connecté ⬡", `Stack « ${r.stack.name} » — analyse lancée`, "ok");
      await refreshStackSelect();
      openStackDetail(r.stack.slug);
    } catch (e) { toast("Échec", e.message, "err"); }
  });
}

/* ---------------------------------------------------------------- dashboard */
async function renderDashboard() {
  const c = $("#content"); c.innerHTML = skeleton(4);
  try {
    if (!state.stack) await refreshStackSelect();
    const [st, ms] = await Promise.all([api(`/api/state${qs()}`), api(`/api/missions` + (state.stack ? `?stack=${state.stack}` : ""))]);
    const k = st.kpis, running = ms.rows.filter(m => m.status === "running");
    const { rows: stacks } = await api("/api/stacks");
    const active = stacks.find(s => s.slug === state.stack);
    c.innerHTML = `
      ${active?.dossier_data?.brand ? `<div class="banner ok"><span class="b-ic">${I.radar2 || I.pulse}</span><div>
        <strong>${esc(active.dossier_data.brand)}</strong> — stack ${active.status === "active" ? "actif ✅" : "en cours de validation"}.
        ${active.status !== "active" ? `Le dossier GTM attend votre validation dans <strong>Stacks</strong>.` : `Workspace swarm : <code>stacks/${esc(active.slug)}/swarm/</code>`}
      </div></div>` : ""}
      <div class="kpis">
        <div class="kpi" data-go="keywords"><div class="k-label">Mots-clés</div><div class="k-value">${nf(k.keywords)}</div><div class="k-extra">${nf(k.keywords_commercial)} intention commerciale</div></div>
        <div class="kpi" data-go="signals"><div class="k-label">Signaux</div><div class="k-value">${nf(k.signals)}</div><div class="k-extra">verbatims scorés</div></div>
        <div class="kpi" data-go="serp"><div class="k-label">Positions suivies</div><div class="k-value">${nf(k.serp_checks)}</div><div class="k-extra">vérifications SERP</div></div>
        <div class="kpi" data-go="missions"><div class="k-label">Missions en cours</div><div class="k-value">${nf(running.length)}</div><div class="k-extra">sur l'ensemble de la flotte</div></div>
      </div>
      <div class="section">
        <div class="section-head"><h2>Lancer une mission</h2><span class="hint">${running.length ? `${running.length} en cours` : "aucune en cours"}</span></div>
        <div class="qa-grid">${Object.entries(ms.types).map(([id, t]) => `
          <button class="qa" data-mission="${id}">
            <span class="qa-ic">${I[t.icon] || I.rocket}</span>
            <strong>${esc(t.label)}</strong><span>${esc(t.desc)}</span>
            <span class="qa-agent">${AGENT_META[t.agent]?.e || ""} ${AGENT_META[t.agent]?.n || t.agent}</span>
          </button>`).join("")}
        </div>
      </div>
      <div class="section">
        <div class="section-head"><h2>Activité récente</h2></div>
        ${st.recent_runs.length ? `<div class="timeline">${st.recent_runs.map(r => `
          <div class="tl-row"><span class="tl-time">${rel(r.started_at)}</span><span class="tl-tool">${esc(r.tool)}</span>
          <span class="tl-args">${esc(r.args || "")}</span>
          <span class="tl-status ${r.status === "ok" ? "ok" : "err"}">${r.status === "ok" ? "✓ terminé" : "✕ " + esc(r.status)}</span></div>`).join("")}</div>`
        : emptyState("Aucune activité sur ce stack", "Lancez une mission ou connectez un nouveau dépôt.", "")}
      </div>`;
    c.querySelectorAll("[data-go]").forEach(el => el.addEventListener("click", e => { e.stopPropagation(); setView(el.dataset.go); }));
    c.querySelectorAll("[data-mission]").forEach(el => el.addEventListener("click", () => openMissionModal(el.dataset.mission)));
    if (running.length) ensurePoll(() => { if (state.view === "dashboard") renderDashboard(); });
  } catch (e) { c.innerHTML = emptyState("Erreur", esc(e.message)); }
}

/* ---------------------------------------------------------------- mots-clés */
async function renderKeywords() {
  const c = $("#content");
  c.innerHTML = `
    <div class="filters">
      <div class="search"><span class="ic">${I.search}</span><input id="kw-q" placeholder="Rechercher un mot-clé…" value="${esc(state.q)}"></div>
      <div class="filter-chips">${INTENTS.map(([v, l]) => `<button class="fchip ${state.intent === v ? "on" : ""}" data-intent="${v}">${l}</button>`).join("")}</div>
      <div class="spacer"></div>
      <a class="btn subtle" href="/api/export/keywords.csv${qs()}">Export CSV</a>
    </div>
    <div id="kw-table">${skeleton(3)}</div>`;
  c.querySelectorAll("[data-intent]").forEach(b => b.addEventListener("click", () => { state.intent = b.dataset.intent; renderKeywords(); }));
  $("#kw-q").addEventListener("input", debounce(() => { state.q = $("#kw-q").value; loadKwTable(); }, 250));
  await loadKwTable();
}
async function loadKwTable() {
  const el = $("#kw-table"); if (!el) return;
  const { rows } = await api(`/api/keywords${qs()}&intent=${encodeURIComponent(state.intent)}&q=${encodeURIComponent(state.q)}`);
  if (!rows.length) {
    el.innerHTML = emptyState("Pas encore de mots-clés", "Lancez une mission « Expansion de mots-clés » — les graines validées du dossier sont pré-remplies.", `<button class="btn primary" data-mission="keywords">${I.plus} Lancer l'expansion</button>`);
    el.querySelector("[data-mission]").addEventListener("click", () => openMissionModal("keywords"));
    return;
  }
  el.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Mot-clé</th><th>Intention</th><th class="num">Score</th><th>Sources</th><th>Vu</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td class="kw">${esc(r.kw)}</td><td>${chipIntent(r.intent)}</td>
      <td class="num"><strong>${nf(Math.round(r.score))}</strong></td>
      <td class="muted small">${esc(r.source || "")}</td>
      <td class="faint small rel-time">${rel(r.last_seen)}</td></tr>`).join("")}
    </tbody></table></div>`;
}

/* ---------------------------------------------------------------- signaux */
async function renderSignals() {
  const c = $("#content"); c.innerHTML = skeleton(3);
  const { rows } = await api(`/api/signals${qs()}`);
  if (!rows.length) {
    c.innerHTML = emptyState("Aucun signal", "Lancez un scan — les verbatims réels alimentent hooks, contenu et personas.",
      `<button class="btn primary" data-mission="social">${I.plus} Lancer un scan</button>`);
    c.querySelector("[data-mission]").addEventListener("click", () => openMissionModal("social"));
    return;
  }
  c.innerHTML = `<div class="sig-grid">${rows.map(s => `
    <div class="card sig">
      <div><span class="chip platform">${esc(s.platform)}</span></div>
      <div class="sig-title"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></div>
      <div class="sig-snippet">${esc(s.snippet)}</div>
      <div class="sig-foot"><span class="faint small rel-time">${rel(s.seen_at)}</span><span class="sig-score">⭐ ${nf(Math.round(s.score))}</span></div>
    </div>`).join("")}</div>`;
}

/* ---------------------------------------------------------------- concurrents */
async function renderCompetitors() {
  const c = $("#content"); c.innerHTML = skeleton(3);
  const { rows } = await api(`/api/competitors${qs()}`);
  const head = `<div class="filters"><div class="spacer"></div><button class="btn primary" data-mission="competitors">${I.plus} Lancer la veille</button></div>`;
  if (!rows.length) {
    c.innerHTML = head + emptyState("Aucun concurrent surveillé", "La veille prend des snapshots des pages concurrents et détecte les changements (prix, offres, wording).");
    c.querySelector("[data-mission]").addEventListener("click", () => openMissionModal("competitors"));
    return;
  }
  c.innerHTML = head + `<div class="table-wrap"><table>
    <thead><tr><th>Cible</th><th>URL</th><th class="num">Versions</th><th>Dernier snapshot</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td class="kw">${esc(r.name)}</td>
      <td class="cell-url"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></td>
      <td class="num">${nf(r.versions)}</td><td class="muted rel-time">${rel(r.last_at)}</td></tr>`).join("")}
    </tbody></table></div>`;
  c.querySelector("[data-mission]").addEventListener("click", () => openMissionModal("competitors"));
}

/* ---------------------------------------------------------------- serp */
async function renderSerp() {
  const c = $("#content"); c.innerHTML = skeleton(3);
  const { rows } = await api(`/api/serp${qs()}`);
  if (!rows.length) {
    c.innerHTML = emptyState("Aucune position suivie", "Construisez l'univers de mots-clés puis lancez la mission « Positions SERP » (SearXNG requis).",
      `<button class="btn primary" data-mission="serp">${I.plus} Vérifier les positions</button>`);
    c.querySelector("[data-mission]").addEventListener("click", () => openMissionModal("serp"));
    return;
  }
  const pos = r => r.position == null ? '<span class="faint">absent</span>'
    : `<strong style="color:${r.position <= 3 ? "var(--ok)" : r.position <= 10 ? "var(--gold)" : "var(--text)"}">#${r.position}</strong>`;
  c.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Requête</th><th class="num">Position</th><th>URL classée</th><th>Vérifié</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td class="kw">${esc(r.kw)}</td><td class="num">${pos(r)}</td>
      <td class="cell-url">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>` : '<span class="faint">—</span>'}</td>
      <td class="faint small rel-time">${rel(r.checked_at)}</td></tr>`).join("")}
    </tbody></table></div>`;
}

/* ---------------------------------------------------------------- missions */
const MISSION_FIELDS = {
  keywords: p => `
    <div class="field"><label>Graines (une par ligne, max 10)</label>
      <textarea id="f-seeds" placeholder="graines validées du dossier…">${esc((p.seeds||[]).join("\n"))}</textarea></div>
    <div class="field-row">
      <div class="field"><label>Profondeur (tours)</label><input type="number" id="f-rounds" min="1" max="4" value="${p.rounds||1}"></div>
      <div class="field"><label>Largeur</label><input type="number" id="f-breadth" min="2" max="12" value="${p.breadth||6}"></div>
    </div>`,
  social: p => `<div class="field"><label>Requêtes personnalisées (optionnel)</label>
      <textarea id="f-queries" placeholder="vide = scan par défaut">${esc((p.queries||[]).join("\n"))}</textarea></div>`,
  competitors: () => `<p class="muted" style="margin-top:14px">Scan des cibles par défaut (modifiable dans <code>tools/competitor_watch.py</code>).</p>`,
  serp: p => `<div class="field"><label>Nombre de mots-clés à vérifier</label><input type="number" id="f-limit" min="5" max="100" value="${p.limit||20}"></div>`,
  trends: p => `<div class="field"><label>Mots-clés (max 5)</label><textarea id="f-kws">${esc((p.kws||[]).join("\n"))}</textarea></div>
    <div class="field"><label>Pays (ISO)</label><input id="f-geo" value="${esc(p.geo||"FR")}" maxlength="2"></div>`,
};
async function renderMissions() {
  const c = $("#content"); c.innerHTML = skeleton(2);
  const { rows, types } = await api("/api/missions");
  if (!rows.length) {
    c.innerHTML = emptyState("Aucune mission", "Les missions exécutent les outils du swarm et alimentent la base du stack sélectionné.",
      `<button class="btn primary" id="m-first">${I.plus} Nouvelle mission</button>`);
    $("#m-first").addEventListener("click", () => openMissionModal());
    return;
  }
  c.innerHTML = rows.map(m => `
    <div class="mission" data-id="${m.id}">
      <div class="mission-head">
        <span class="m-id">#${String(m.id).padStart(3,"0")}</span>
        <span class="pill ${m.status}"><span class="dot"></span>${m.status === "running" ? "en cours" : m.status === "done" ? "terminée" : "échec"}</span>
        <span class="m-label">${esc(m.label)}</span>
        ${m.stack ? `<span class="chip unknown">${esc(m.stack)}</span>` : ""}
        <span class="m-meta">${AGENT_META[m.agent]?.e || ""} ${esc(m.agent)} · ${rel(m.started)}</span>
      </div>
      <div class="m-log" id="mlog-${m.id}" style="display:${String(state.openMission) === String(m.id) ? "block" : "none"}"><span class="m-empty">chargement…</span></div>
    </div>`).join("");
  c.querySelectorAll(".mission-head").forEach(h => h.addEventListener("click", () => {
    const id = h.parentElement.dataset.id;
    const log = $(`#mlog-${id}`);
    const open = log.style.display !== "none";
    log.style.display = open ? "none" : "block";
    state.openMission = open ? null : id;
    if (!open) loadLog(id);
  }));
  if (state.openMission) loadLog(state.openMission);
  if (rows.some(m => m.status === "running")) ensurePoll(async () => {
    if (state.view !== "missions") return;
    const { rows: fresh } = await api("/api/missions");
    for (const m of fresh) {
      if (m.status === "running" && String(state.openMission) === String(m.id)) loadLog(m.id, true);
      const pill = c.querySelector(`.mission[data-id="${m.id}"] .pill`);
      if (pill && !pill.classList.contains(m.status)) { render(); return; }
    }
    if (!fresh.some(m => m.status === "running")) { stopPoll(); render(); }
  });
}
async function loadLog(id, quiet=false) {
  const el = $(`#mlog-${id}`); if (!el) return;
  try {
    const { log, status } = await api(`/api/missions/${id}/log`);
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.textContent = log || "… en attente de sortie …";
    if (stick || !quiet) el.scrollTop = el.scrollHeight;
    if (status !== "running" && !quiet) render();
  } catch { el.textContent = "log indisponible"; }
}

/* ---------------------------------------------------------------- rapports */
async function renderReports() {
  const c = $("#content");
  if (state.reportPath) return renderReportViewer();
  c.innerHTML = skeleton(2);
  const { rows } = await api(`/api/reports${qs()}`);
  if (!rows.length) {
    c.innerHTML = emptyState("Aucun rapport", "Les livrables apparaissent ici : dossier GTM, veilles, livrables poussés par les agents.");
    return;
  }
  c.innerHTML = rows.map(r => `
    <div class="rep-list-item" data-path="${esc(r.path)}">
      <div class="rep-icon">${r.name.endsWith(".csv") ? I.csv : I.doc}</div>
      <div><div class="rep-name">${esc(r.name)}</div><div class="rep-path">${esc(r.path)}</div></div>
      <div class="rep-meta">${rel(r.mtime)} · ${nf(Math.round(r.size/102.4)/10)} Ko</div>
    </div>`).join("");
  c.querySelectorAll("[data-path]").forEach(el => el.addEventListener("click", () => { state.reportPath = el.dataset.path; renderReports(); }));
}
async function renderReportViewer() {
  const c = $("#content"); c.innerHTML = skeleton(1);
  const { content } = await api(`/api/report${qs()}&path=${encodeURIComponent(state.reportPath)}`);
  const isCsv = state.reportPath.endsWith(".csv");
  c.innerHTML = `
    <div class="back-row"><button class="btn subtle" id="rep-back"><span class="ic">${I.arrow}</span> Retour</button>
      <span class="faint small">${esc(state.reportPath)}</span></div>
    <div class="rep-viewer">${isCsv ? `<pre>${esc(content)}</pre>` : md(content)}</div>`;
  $("#rep-back").addEventListener("click", () => { state.reportPath = null; renderReports(); });
}

/* ---------------------------------------------------------------- agents */
async function renderAgents() {
  const c = $("#content"); c.innerHTML = skeleton(3);
  const st = await api(`/api/state${qs()}`);
  const { rows: ms } = await api("/api/missions");
  const busy = new Set(ms.filter(m => m.status === "running").map(m => m.agent));
  c.innerHTML = `<div class="agents-grid">${st.agents.map(a => `
    <div class="card agent-card">
      <div class="agent-top"><div class="agent-emoji">${a.emoji}</div>
        <div><div class="agent-name">${esc(a.name)}</div><div class="agent-role">${esc(a.role)}</div></div></div>
      <div class="agent-desc">${esc(a.desc)}</div>
      <div class="agent-skills">${a.skills.map(s => `<span class="chip unknown">${esc(s)}</span>`).join("")}</div>
      <div class="agent-foot">
        <span>${busy.has(a.id) ? '<span class="pill running"><span class="dot"></span>au travail</span>' : '<span class="pill done"><span class="dot"></span>disponible</span>'}</span>
      </div>
    </div>`).join("")}</div>
  <p class="small faint" style="margin-top:16px">La flotte s'exécute dans votre OpenClaw ou Hermes Agent — QeyNox en est la surface de contrôle métier. Les agents poussent leurs livrables via <code>POST /api/hooks/agent</code>.</p>`;
}

/* ---------------------------------------------------------------- modal mission (stack-aware) */
let TYPES_CACHE = null;
async function openMissionModal(preselect=null, suggestedParams=null) {
  if (!TYPES_CACHE) TYPES_CACHE = (await api("/api/missions")).types;
  const types = TYPES_CACHE;
  let selected = preselect && types[preselect] ? preselect : Object.keys(types)[0];
  const root = $("#modal-root");
  const draw = () => {
    const t = types[selected];
    const params = suggestedParams && suggestedParams[selected] ? suggestedParams[selected] : {};
    root.innerHTML = `
    <div class="modal-backdrop" id="mb">
      <div class="modal">
        <div class="modal-head"><h3>Nouvelle mission</h3><button class="modal-close" id="mclose">${I.x}</button></div>
        <div class="modal-body">
          <div class="mtypes">${Object.entries(types).map(([id, ty]) => `
            <button class="mtype ${id === selected ? "on" : ""}" data-t="${id}">
              <span class="qa-ic">${I[ty.icon] || I.rocket}</span><strong>${esc(ty.label)}</strong><span>${esc(ty.desc)}</span>
            </button>`).join("")}
          </div>
          ${state.stack ? `<p class="small faint" style="margin-top:14px">Stack cible : <strong>${esc(state.stack)}</strong></p>` : ""}
          <form id="mform" onsubmit="return false">${MISSION_FIELDS[selected](params)}
            <div class="f-hint" style="margin-top:10px">Résultats stockés dans la base du stack sélectionné.</div>
          </form>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" id="mcancel">Annuler</button>
          <button class="btn primary" id="mlaunch">Lancer la mission</button>
        </div>
      </div>
    </div>`;
    root.querySelectorAll("[data-t]").forEach(b => b.addEventListener("click", () => { selected = b.dataset.t; draw(); }));
    $("#mclose").addEventListener("click", close); $("#mcancel").addEventListener("click", close);
    $("#mb").addEventListener("click", e => { if (e.target.id === "mb") close(); });
    $("#mlaunch").addEventListener("click", launch);
    const ta = $("#f-seeds") || $("#f-queries") || $("#f-kws"); if (ta) ta.focus();
  };
  const collect = () => {
    const v = id => { const el = $(id); return el ? el.value : null; };
    const lines = id => (v(id) || "").split("\n").map(s => s.trim()).filter(Boolean);
    const p = {};
    if (selected === "keywords") { p.seeds = lines("#f-seeds"); p.rounds = +v("#f-rounds") || 1; p.breadth = +v("#f-breadth") || 6; }
    if (selected === "social") p.queries = lines("#f-queries");
    if (selected === "serp") p.limit = +v("#f-limit") || 20;
    if (selected === "trends") { p.kws = lines("#f-kws"); p.geo = (v("#f-geo") || "FR").trim(); }
    return p;
  };
  const close = () => { root.innerHTML = ""; };
  const launch = async () => {
    try {
      const r = await api("/api/missions", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: selected, params: collect(), stack: state.stack }) });
      close();
      toast("Mission lancée", `#${String(r.mission.id).padStart(3,"0")} — ${r.mission.label}`, "ok");
      state.openMission = r.mission.id;
      setView("missions");
    } catch (e) { toast("Impossible de lancer", e.message, "err"); }
  };
  draw();
}

/* ---------------------------------------------------------------- boot */
document.querySelectorAll(".nav-item").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
$("#btn-onboard").addEventListener("click", openOnboardModal);
$("#btn-refresh").addEventListener("click", () => { render(); });
$("#stack-select").addEventListener("change", e => {
  state.stack = e.target.value; localStorage.setItem("qx-stack", state.stack); render();
});
async function updateSearxDot() {
  try { const h = await api("/api/health"); $("#searx-status .dot").className = "dot " + (h.searxng ? "up" : "down"); }
  catch { $("#searx-status .dot").className = "dot down"; }
}
updateSearxDot(); setInterval(updateSearxDot, 15000);
refreshStackSelect().then(() => setView("stacks"));
