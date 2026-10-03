#!/usr/bin/env python3
"""QeyNox — Runtime de boucles (L2 heartbeat, L3 événements, L4/L7-lite réflexion, L5-lite retry).

Ce que fait ce module, concrètement :
  L2  Heartbeat        : programmes récurrents par stack (programs.json), exécutés à leur cadence.
  L3  Événements       : programme « rescan » — détecte un git push / changement du dépôt source
                         et re-programme immédiatement la research (keywords + competitors).
  Auto-dispatch        : au premier cycle, consomme swarm/missions-suggested.json → programmes.
  L4/L7-lite Réflexion : score de santé heuristique + rapport output/pulse.md après chaque cycle.
  L5-lite Retry        : échec → retry dans 1 h (jamais immédiat) ; 3 échecs consécutifs →
                         programme désactivé + alerte dans le pulse (jamais silencieux).
  Garde-fous           : timeout par run, 1 exécution à la fois, plafond de runs/jour/stack,
                         kill switch global (fichier stacks/.halt, CLI --halt/--resume).

CLI :
  python3 engine/loops.py --once [slug]    un cycle (test / cron externe)
  python3 engine/loops.py --daemon         boucle permanente (tick CHECK_INTERVAL s)
  python3 engine/loops.py --status         état des boucles par stack
  python3 engine/loops.py --halt|--resume  kill switch global
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(ENGINE_DIR, ".."))
STACKS = os.path.join(ROOT, "stacks")
TOOLS = os.path.join(ROOT, "tools")
LOGS = os.path.join(ROOT, "logs")
HALT_FILE = os.path.join(STACKS, ".halt")

CHECK_INTERVAL = 60          # secondes entre deux ticks du daemon
RETRY_DELAY = 3600           # 1 h après un échec
MAX_FAILURES = 3             # échecs consécutifs avant désactivation
MAX_RUNS_PER_DAY = 12        # plafond par stack (garde-fou budget)
RUN_TIMEOUTS = {             # timeout par type de programme (secondes)
    "keywords": 420, "social": 180, "competitors": 300,
    "serp": 420, "trends": 120, "rescan": 30,
}


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json(path, default):
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return default
    return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


# --------------------------------------------------------------------------- stacks

def list_stacks() -> list[str]:
    out = []
    if os.path.isdir(STACKS):
        for s in sorted(os.listdir(STACKS)):
            d = os.path.join(STACKS, s)
            if os.path.isdir(d) and os.path.exists(os.path.join(d, "data", "gtm.db")):
                out.append(s)
    return out


def db_counts(slug: str) -> dict:
    db = os.path.join(STACKS, slug, "data", "gtm.db")
    counts = {"keywords": 0, "signals": 0, "competitors": 0}
    tables = {"keywords": "keywords", "signals": "signals", "competitors": "snapshots"}
    try:
        con = sqlite3.connect(db)
        for key, table in tables.items():
            try:
                counts[key] = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            except sqlite3.OperationalError:
                pass
        con.close()
    except Exception:
        pass
    return counts


def stack_meta(slug: str) -> dict:
    rows = read_json(os.path.join(STACKS, "registry.json"), [])
    if not isinstance(rows, list):
        return {}
    for s in rows:
        if isinstance(s, dict) and s.get("slug") == slug:
            return s
    return {}


def stack_domain(slug: str) -> str:
    url = (stack_meta(slug).get("site_url") or "").strip()
    return urlparse(url).netloc.lower().removeprefix("www.")


def brand_of(slug: str) -> str:
    ctx = read_json(os.path.join(STACKS, slug, "context", "repo-analysis.json"), {})
    return (ctx.get("brand", {}) or {}).get("guess") or slug


# --------------------------------------------------------------------------- programmes

def default_programs(slug: str) -> list[dict]:
    """Construit les programmes depuis missions-suggested.json (auto-dispatch) + défauts."""
    missions = read_json(os.path.join(STACKS, slug, "swarm", "missions-suggested.json"), [])
    seeds = read_json(os.path.join(STACKS, slug, "swarm", "keywords-seeds.json"), {})
    validated = seeds.get("validated_seeds", [])
    programs: list[dict] = []
    used: list[str] = []

    for m in missions if isinstance(missions, list) else []:
        t = m.get("type")
        p = m.get("params", {}) or {}
        if t == "keywords":
            s = (p.get("seeds") or validated)[:8]
            programs.append({"id": "keywords-enrich", "type": "keywords", "label": m.get("label", "Enrichir les mots-clés"),
                             "every_h": 0, "params": {"seeds": s}, "enabled": True})   # one-shot
        elif t == "social":
            programs.append({"id": "social-pulse", "type": "social", "label": m.get("label", "Signaux sociaux"),
                             "every_h": 48, "params": {"queries": p.get("queries") or []}, "enabled": True})
        elif t == "competitors":
            programs.append({"id": "competitors-watch", "type": "competitors", "label": m.get("label", "Veille concurrents"),
                             "every_h": 72, "params": {}, "enabled": True})
        elif t == "serp":
            programs.append({"id": "serp-rank", "type": "serp", "label": m.get("label", "Positions SERP"),
                             "every_h": 168, "params": {"limit": int(p.get("limit", 20))}, "enabled": True})
        if t:
            used.append(t)

    # Défauts pour tout ce que les missions ne couvrent pas + boucle d'événements
    if "social" not in used:
        programs.append({"id": "social-pulse", "type": "social", "label": "Signaux sociaux (défaut)",
                         "every_h": 48, "params": {"queries": []}, "enabled": True})
    if "competitors" not in used:
        programs.append({"id": "competitors-watch", "type": "competitors", "label": "Veille concurrents (défaut)",
                         "every_h": 72, "params": {}, "enabled": True})
    if "serp" not in used:
        programs.append({"id": "serp-rank", "type": "serp", "label": "Positions SERP (défaut)",
                         "every_h": 168, "params": {"limit": 20}, "enabled": True})
    if "keywords" not in used and validated:
        programs.append({"id": "keywords-enrich", "type": "keywords", "label": "Enrichir les mots-clés (défaut)",
                         "every_h": 0, "params": {"seeds": validated[:8]}, "enabled": True})
    programs.append({"id": "trends-check", "type": "trends", "label": "Tendances de recherche",
                     "every_h": 336, "params": {}, "enabled": True})
    programs.append({"id": "rescan-event", "type": "rescan", "label": "Détection git push / changement source",
                     "every_h": 24, "params": {}, "enabled": True})
    return programs


def load_programs(slug: str) -> tuple[list[dict], bool]:
    """Retourne (programmes, freshly_dispatched)."""
    path = os.path.join(STACKS, slug, "programs.json")
    progs = read_json(path, None)
    if progs:
        return progs, False
    progs = default_programs(slug)
    # Journaliser le dispatch des missions
    dispatched = [{"type": p["type"], "program": p["id"], "label": p["label"],
                   "every_h": p["every_h"], "dispatched_at": now()} for p in progs]
    write_json(os.path.join(STACKS, slug, "swarm", "missions-dispatched.json"),
               {"dispatched_at": now(), "programs": dispatched})
    write_json(path, progs)
    return progs, True


def save_programs(slug: str, progs: list[dict]):
    write_json(os.path.join(STACKS, slug, "programs.json"), progs)


# --------------------------------------------------------------------------- exécution

def build_cmd(prog: dict, slug: str) -> list[str]:
    t, p = prog["type"], prog.get("params", {})
    py = sys.executable
    if t == "keywords":
        cmd = [py, os.path.join(TOOLS, "keyword_research.py")]
        for s in (p.get("seeds") or [])[:8]:
            cmd += ["--seed", str(s)]
        return cmd
    if t == "social":
        cmd = [py, os.path.join(TOOLS, "social_pulse.py")]
        qs = p.get("queries") or [brand_of(slug)]
        for q in qs[:5]:
            cmd += ["--q", str(q)]
        return cmd
    if t == "competitors":
        return [py, os.path.join(TOOLS, "competitor_watch.py"), "--scan"]
    if t == "serp":
        cmd = [py, os.path.join(TOOLS, "serp_rank.py"), "--from-store",
               "--limit", str(int(p.get("limit", 20)))]
        dom = stack_domain(slug)
        if dom:
            cmd += ["--domain", dom]
        return cmd
    if t == "trends":
        kws = [r[0] for r in _top_kws(slug, 5)] or [brand_of(slug)]
        cmd = [py, os.path.join(TOOLS, "trends_check.py")]
        for k in kws:
            cmd += ["--kw", k]
        return cmd + ["--geo", "FR"]
    return []


def _top_kws(slug: str, n: int) -> list[tuple]:
    try:
        con = sqlite3.connect(os.path.join(STACKS, slug, "data", "gtm.db"))
        rows = con.execute("SELECT kw FROM keywords ORDER BY score DESC LIMIT ?", (n,)).fetchall()
        con.close()
        return rows
    except Exception:
        return []


def _git_stdout(repo: str, *args: str, timeout: int = 10) -> str:
    try:
        proc = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return proc.stdout.strip() if proc.returncode == 0 else ""


def _mtime_fingerprint(root: str) -> str:
    digest = hashlib.sha256()
    seen = 0
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__")]
        for fname in sorted(files):
            path = os.path.join(dirpath, fname)
            try:
                digest.update(fname.encode())
                digest.update(str(os.path.getmtime(path)).encode())
                seen += 1
            except OSError:
                pass
    return digest.hexdigest()[:16] if seen else ""


def _repo_candidates(slug: str) -> list[str]:
    found: list[str] = []
    ctx = read_json(os.path.join(STACKS, slug, "context", "repo-analysis.json"), {})
    src = os.path.expanduser(str(ctx.get("source") or ""))
    if ctx.get("source_mode") == "local" and src and os.path.isdir(src):
        found.append(src)
    for path in (os.path.join(STACKS, slug, "repo", "repo"), os.path.join(STACKS, slug, "repo")):
        if os.path.isdir(path) and path not in found:
            found.append(path)
    return found


def _is_shallow(repo: str) -> bool:
    rel = _git_stdout(repo, "rev-parse", "--git-path", "shallow")
    if not rel:
        return False
    path = rel if os.path.isabs(rel) else os.path.join(repo, rel)
    return os.path.isfile(path)


def _git_fingerprint(repo: str) -> str:
    """HEAD du remote si origin existe (fetch), sinon HEAD local.

    --depth 1 seulement sur un clone déjà shallow : l'appliquer à un dépôt
    complet le tronquerait.
    """
    if _git_stdout(repo, "remote"):
        cmd = ["git", "-C", repo, "fetch", "origin"]
        if _is_shallow(repo):
            cmd = ["git", "-C", repo, "fetch", "--depth", "1", "origin"]
        try:
            subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            pass
        fetched = _git_stdout(repo, "rev-parse", "FETCH_HEAD")
        if fetched:
            return fetched
    return _git_stdout(repo, "rev-parse", "HEAD")


def source_fingerprint(slug: str) -> str:
    """Empreinte du vrai checkout : remote HEAD, HEAD local, ou mtime du dossier source."""
    parent = os.path.abspath(os.path.join(STACKS, slug, "repo"))
    for repo in _repo_candidates(slug):
        if _git_stdout(repo, "rev-parse", "--is-inside-work-tree") == "true":
            head = _git_fingerprint(repo)
            if head:
                return head
            continue
        if os.path.abspath(repo) == parent and os.path.isdir(os.path.join(parent, "repo")):
            continue
        digest = _mtime_fingerprint(repo)
        if digest:
            return digest
    ctx = os.path.join(STACKS, slug, "context", "repo-analysis.json")
    if os.path.exists(ctx):
        digest = hashlib.sha256()
        with open(ctx, "rb") as fh:
            digest.update(fh.read())
        return digest.hexdigest()[:16]
    return ""


def run_program(slug: str, prog: dict, programs: list[dict] | None = None) -> dict:
    """Exécute un programme de façon SYNCHRONE (la boucle doit savoir si ça a marché)."""
    t0 = time.time()
    before = db_counts(slug)
    res = {"program": prog["id"], "type": prog["type"], "at": now(), "ok": False, "note": ""}
    if prog["type"] == "rescan":
        fp = source_fingerprint(slug)
        state_prev = read_json(os.path.join(STACKS, slug, "loop_state.json"), {})
        prev = state_prev.get("source_fingerprint", "")
        res["ok"] = True
        if prev and fp and prev != fp:
            res["note"] = "changement source détecté → re-scan research déclenché"
            target = programs if programs is not None else load_programs(slug)[0]
            for other in target:
                if other["type"] in ("keywords", "competitors") and other.get("enabled"):
                    other["next_run"] = now()   # re-scan immédiat
            if programs is None:
                save_programs(slug, target)
        elif not fp:
            res["note"] = "pas de source fingerprintable (site-only) — ignoré"
        else:
            res["note"] = "source inchangée"
        res["duration_s"] = round(time.time() - t0, 1)
        res["fingerprint"] = fp
        return res

    cmd = build_cmd(prog, slug)
    if not cmd:
        res["note"] = "type de programme inconnu"
        return res
    db = os.path.join(STACKS, slug, "data", "gtm.db")
    brand = brand_of(slug)
    env = {
        **os.environ,
        "GTM_DB": db,
        "GTM_LANG": "fr",
        "GTM_GL": "FR",
        "GTM_BRAND": brand,
        "GTM_BRAND_ALIASES": brand,
        "GTM_DOMAIN": stack_domain(slug),
    }
    os.makedirs(LOGS, exist_ok=True)
    log_path = os.path.join(LOGS, f"loop-{slug}-{prog['id']}-{datetime.now().strftime('%H%M%S')}.log")
    try:
        with open(log_path, "w") as log:
            r = subprocess.run(cmd, cwd=os.path.join(STACKS, slug), env=env,
                               stdout=log, stderr=subprocess.STDOUT,
                               timeout=RUN_TIMEOUTS.get(prog["type"], 300))
        res["ok"] = (r.returncode == 0)
        res["note"] = "ok" if res["ok"] else f"exit {r.returncode} (log: {os.path.basename(log_path)})"
    except subprocess.TimeoutExpired:
        res["note"] = f"timeout > {RUN_TIMEOUTS.get(prog['type'], 300)}s (log: {os.path.basename(log_path)})"
    after = db_counts(slug)
    res["duration_s"] = round(time.time() - t0, 1)
    res["delta"] = {k: after[k] - before[k] for k in before if after[k] != before[k]}
    if res["ok"] and res["delta"]:
        res["note"] += " · +" + ", +".join(f"{v} {k}" for k, v in res["delta"].items())
    return res


# --------------------------------------------------------------------------- réflexion (L4/L7-lite)

def health_score(slug: str, programs: list[dict]) -> tuple[int, list[str]]:
    """Score de santé heuristique /100 + alertes. Remplacé/complété par le LLM-juge en V2."""
    c = db_counts(slug)
    alerts: list[str] = []
    kw = 25 if c["keywords"] >= 30 else 15 if c["keywords"] >= 15 else 5
    sig = 20 if c["signals"] >= 30 else 12 if c["signals"] >= 10 else 4
    comp = 15 if c["competitors"] >= 3 else 8 if c["competitors"] >= 1 else 0
    aeo = 0
    aeo_data = read_json(os.path.join(STACKS, slug, "research", "aeo.json"), {})
    score_aeo = aeo_data.get("score") or (aeo_data.get("data", {}) or {}).get("score")
    if isinstance(score_aeo, (int, float)):
        aeo = round(score_aeo / 100 * 20)
    fresh = 0
    last_ok = ""
    for p in programs:
        if p.get("last_ok_at") and p["last_ok_at"] > last_ok:
            last_ok = p["last_ok_at"]
    if last_ok:
        age_days = (time.time() - time.mktime(time.strptime(last_ok, "%Y-%m-%dT%H:%M:%SZ"))) / 86400
        fresh = 20 if age_days <= 7 else 10 if age_days <= 14 else 0
        if age_days > 7:
            alerts.append(f"données vieillissantes (dernier run réussi il y a {age_days:.0f} j)")
    else:
        alerts.append("aucun programme n'a encore réussi")
    disabled = [p["id"] for p in programs
                if not p.get("enabled", True) and p.get("note") != "one-shot terminé"]
    if disabled:
        alerts.append("programmes désactivés (échecs répétés ?) : " + ", ".join(disabled))
    if os.path.exists(HALT_FILE):
        alerts.append("⚠️ KILL SWITCH ACTIF (stacks/.halt) — boucles en pause")
    return kw + sig + comp + aeo + fresh, alerts


def write_pulse(slug: str, results: list[dict], programs: list[dict], health: int, alerts: list[str]):
    today = datetime.now(timezone.utc).strftime("%d/%m/%Y %H:%M UTC")
    icon = "🟢" if health >= 70 else "🟡" if health >= 40 else "🔴"
    lines = [f"# 📡 Pulse QeyNox — {slug}", "",
             f"> Cycle du {today} — **santé {health}/100** {icon} (score heuristique ; LLM-juge en V2)", ""]
    if results:
        lines += ["## Exécutions de ce cycle", "",
                  "| Programme | Type | Résultat | Durée |", "|---|---|---|---|"]
        for r in results:
            status = "✅" if r["ok"] else "❌"
            lines.append(f"| {r['program']} | {r['type']} | {status} {r['note']} | {r.get('duration_s','—')} s |")
    else:
        lines += ["## Exécutions de ce cycle", "", "*Rien à exécuter — tous les programmes sont à leur cadence.*"]
    c = db_counts(slug)
    lines += ["", "## Santé des données", "",
              f"- Mots-clés : **{c['keywords']}** · Signaux : **{c['signals']}** · Concurrents : **{c['competitors']}**",
              f"- Programmes : {sum(1 for p in programs if p.get('enabled', True))} actifs / {len(programs)}", ""]
    if alerts:
        lines += ["## ⚠️ Alertes", ""] + [f"- {a}" for a in alerts] + [""]
    out = os.path.join(STACKS, slug, "output")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "pulse.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


# --------------------------------------------------------------------------- cycle

def cycle(slugs: list[str] | None = None) -> dict:
    halt = os.path.exists(HALT_FILE)
    summary = {}
    for slug in (slugs or list_stacks()):
        progs, fresh_dispatch = load_programs(slug)
        journal = os.path.join(STACKS, slug, "loop.jsonl")
        state = read_json(os.path.join(STACKS, slug, "loop_state.json"),
                          {"runs_today": 0, "runs_today_date": "", "source_fingerprint": ""})
        today = datetime.now().strftime("%Y-%m-%d")
        if state.get("runs_today_date") != today:
            state["runs_today"], state["runs_today_date"] = 0, today

        results = []
        if halt:
            results.append({"program": "(halt)", "type": "-", "ok": True,
                            "note": "kill switch actif — cycle ignoré", "duration_s": 0})
        else:
            for p in progs:
                if not p.get("enabled", True):
                    continue
                if p.get("next_run") and p["next_run"] <= now():
                    due = True
                elif not p.get("next_run"):
                    due = True                      # premier lancement
                else:
                    due = False
                if not due:
                    continue
                if state["runs_today"] >= MAX_RUNS_PER_DAY:
                    results.append({"program": p["id"], "type": p["type"], "ok": True,
                                    "note": f"plafond {MAX_RUNS_PER_DAY} runs/jour atteint — reporté",
                                    "duration_s": 0})
                    break
                r = run_program(slug, p, progs)
                results.append(r)
                state["runs_today"] += 1
                if r["ok"]:
                    p["failures"] = 0
                    p["last_ok_at"] = r["at"]
                    if p["every_h"] <= 0:           # one-shot terminé
                        p["enabled"] = False
                        p["note"] = "one-shot terminé"
                        p["next_run"] = None
                    else:
                        p["next_run"] = datetime.fromtimestamp(
                            time.time() + p["every_h"] * 3600).strftime("%Y-%m-%dT%H:%M:%SZ")
                else:
                    p["failures"] = p.get("failures", 0) + 1
                    if p["failures"] >= MAX_FAILURES:
                        p["enabled"] = False
                        p["note"] = f"désactivé après {p['failures']} échecs consécutifs"
                        p["next_run"] = None
                    else:
                        p["next_run"] = datetime.fromtimestamp(
                            time.time() + RETRY_DELAY).strftime("%Y-%m-%dT%H:%M:%SZ")
                if r.get("fingerprint"):
                    state["source_fingerprint"] = r["fingerprint"]
                elif not state.get("source_fingerprint"):
                    state["source_fingerprint"] = source_fingerprint(slug)
                with open(journal, "a", encoding="utf-8") as f:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
                if not any(x["program"] == "(halt)" for x in results):
                    pass
            save_programs(slug, progs)

        health, alerts = health_score(slug, progs)
        if fresh_dispatch:
            alerts.insert(0, f"auto-dispatch : {len(progs)} programmes créés depuis missions-suggested.json")
        write_pulse(slug, results, progs, health, alerts)
        state["last_cycle"] = now()
        state["health"] = health
        state["alerts"] = alerts
        write_json(os.path.join(STACKS, slug, "loop_state.json"), state)
        summary[slug] = {"runs": len([r for r in results if r["program"] != "(halt)"]),
                         "health": health, "halt": halt}
    return summary


# --------------------------------------------------------------------------- CLI

def cmd_status():
    for slug in list_stacks():
        st = read_json(os.path.join(STACKS, slug, "loop_state.json"), {})
        progs = read_json(os.path.join(STACKS, slug, "programs.json"), [])
        print(f"\n=== {slug} — santé {st.get('health', '?')}/100 — dernier cycle {st.get('last_cycle', '—')} ===")
        for p in progs:
            flag = "✅" if p.get("enabled", True) else "⛔"
            print(f"  {flag} {p['id']:<18} {p['type']:<12} every {p['every_h']:>4} h  "
                  f"next {p.get('next_run') or '—':<20} échecs {p.get('failures', 0)}")


def main():
    argv = sys.argv[1:]
    if "--halt" in argv:
        os.makedirs(STACKS, exist_ok=True)
        open(HALT_FILE, "w").close()
        print("kill switch ACTIVÉ — les boucles se mettent en pause au prochain cycle.")
        return
    if "--resume" in argv:
        if os.path.exists(HALT_FILE):
            os.remove(HALT_FILE)
        print("kill switch levé — boucles réactivées.")
        return
    if "--status" in argv:
        cmd_status()
        return
    slugs = [a for a in argv if not a.startswith("--")] or None
    if "--daemon" in argv:
        print(f"[loops] daemon démarré (tick {CHECK_INTERVAL}s, stacks: {list_stacks() or '—'})", flush=True)
        while True:
            try:
                s = cycle(slugs)
                print(f"[loops] {now()} cycle → {json.dumps(s, ensure_ascii=False)}", flush=True)
            except Exception as e:
                print(f"[loops] ERREUR cycle: {e!r}", flush=True)
            time.sleep(CHECK_INTERVAL)
    else:  # --once (défaut)
        s = cycle(slugs)
        print(json.dumps(s, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
