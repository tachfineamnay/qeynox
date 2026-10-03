#!/usr/bin/env python3
"""QeyNox — Analyse d'un dépôt : stack technique + extraction du contexte produit.

Entrée : chemin local, URL git (https/git@) ou archive .zip.
Sortie : stacks/<slug>/context/repo-analysis.json + resume markdown lisible.
100 % déterministe (aucune clé API) : parsing de manifests, HTML, README, configs.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urlparse, urlsplit, urlunsplit

SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env", "dist", "build",
    "out", "target", ".next", ".nuxt", ".output", "coverage", ".cache", "vendor",
    "site-packages", ".turbo", ".parcel-cache", ".svelte-kit",
}
MAX_FILES = 4000

LANG_MAP = {
    ".py": "Python", ".js": "JavaScript", ".jsx": "JavaScript", ".ts": "TypeScript",
    ".tsx": "TypeScript", ".html": "HTML", ".htm": "HTML", ".css": "CSS", ".scss": "CSS",
    ".md": "Markdown", ".go": "Go", ".rb": "Ruby", ".php": "PHP", ".java": "Java",
    ".rs": "Rust", ".sh": "Shell", ".bash": "Shell", ".yml": "YAML", ".yaml": "YAML",
    ".sql": "SQL", ".dart": "Dart", ".swift": "Swift", ".kt": "Kotlin", ".c": "C",
    ".cpp": "C++", ".cs": "C#", ".toml": "TOML",
}

# deps package.json -> frameworks
JS_FRAMEWORKS = {
    "next": "Next.js", "nuxt": "Nuxt", "@sveltejs/kit": "SvelteKit", "svelte": "Svelte",
    "vue": "Vue", "react": "React", "astro": "Astro", "gatsby": "Gatsby",
    "express": "Express", "fastify": "Fastify", "nestjs": "NestJS", "@nestjs/core": "NestJS",
    "tailwindcss": "Tailwind CSS", "vite": "Vite", "typescript": "TypeScript",
    "stripe": "Stripe", "@stripe/stripe-js": "Stripe", "openai": "OpenAI",
    "@anthropic-ai/sdk": "Anthropic", "langchain": "LangChain", "firebase": "Firebase",
    "supabase": "Supabase", "prisma": "Prisma", "three": "Three.js",
}
PY_FRAMEWORKS = {
    "fastapi": "FastAPI", "django": "Django", "flask": "Flask", "streamlit": "Streamlit",
    "scrapy": "Scrapy", "openai": "OpenAI", "anthropic": "Anthropic", "stripe": "Stripe",
    "crewai": "CrewAI", "langchain": "LangChain", "pytrends": "pytrends", "requests": "requests",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_git_url(source: str) -> bool:
    return bool(re.match(r"^(https?://|git@)[^\s]+", source)) and not source.endswith(".zip")


_GIT_USERINFO = re.compile(r"(https?://)[^\s/@]+(?::[^\s/@]*)?@")


def redact_git_url(source: str) -> str:
    """Retire user:token@ des URL https avant toute persistance."""
    source = (source or "").strip()
    if not is_git_url(source):
        return source
    try:
        parts = urlsplit(source)
    except ValueError:
        return _GIT_USERINFO.sub(r"\1", source)
    if parts.scheme in ("http", "https") and "@" in parts.netloc:
        host = parts.hostname or ""
        netloc = f"{host}:{parts.port}" if parts.port else host
        return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
    return source


def scrub_git_credentials(text: str) -> str:
    return _GIT_USERINFO.sub(r"\1", text or "")


def _inside(root: str, candidate: str) -> bool:
    root_a = os.path.normcase(os.path.abspath(root))
    cand_a = os.path.normcase(os.path.abspath(candidate))
    try:
        return os.path.commonpath([root_a, cand_a]) == root_a
    except ValueError:
        return False


def _safe_extract_zip(archive: zipfile.ZipFile, dest: str) -> None:
    dest_abs = os.path.abspath(dest)
    os.makedirs(dest_abs, exist_ok=True)
    for info in archive.infolist():
        target = os.path.abspath(os.path.join(dest_abs, info.filename))
        if not _inside(dest_abs, target):
            raise RuntimeError(f"zip refusé: {info.filename}")
    archive.extractall(dest_abs)


def prepare_repo(source: str, workdir: str) -> tuple[str, str]:
    """Retourne (chemin du dépôt, mode d'obtention). Nettoie si besoin."""
    source = source.strip().strip('"').strip("'")
    if os.path.isdir(os.path.expanduser(source)):
        return os.path.expanduser(source), "local"
    if source.endswith(".zip") and os.path.isfile(os.path.expanduser(source)):
        dest = os.path.join(workdir, "repo")
        if os.path.exists(dest):
            shutil.rmtree(dest)
        with zipfile.ZipFile(os.path.expanduser(source)) as z:
            _safe_extract_zip(z, dest)
        # si l'archive contient un seul dossier racine, le descendre
        entries = os.listdir(dest)
        if len(entries) == 1 and os.path.isdir(os.path.join(dest, entries[0])):
            dest = os.path.join(dest, entries[0])
        return dest, "zip"
    if is_git_url(source):
        if not shutil.which("git"):
            raise RuntimeError("git indisponible sur cette machine — fournissez un chemin local ou un .zip")
        dest = os.path.join(workdir, "repo")
        if os.path.exists(dest):
            shutil.rmtree(dest)
        cmd = ["git", "clone", "--depth", "1", source, dest]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if p.returncode != 0:
            raise RuntimeError(scrub_git_credentials(f"git clone a échoué: {p.stderr.strip()[:300]}"))
        return dest, "git"
    raise RuntimeError(f"Source introuvable ou non supportée: {source}")


class PageParser(HTMLParser):
    """Extrait title, meta description, og:*, h1/h2, liens, présence JSON-LD."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.meta_desc = ""
        self.og: dict[str, str] = {}
        self.h1: list[str] = []
        self.h2: list[str] = []
        self.links: list[tuple[str, str]] = []
        self.has_jsonld = False
        self._in = None       # 'h1' | 'h2' | 'title'
        self._buf: list[str] = []
        self._href = None
        self._link_text: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title":
            self._in = "title"; self._buf = []
        elif tag == "h1":
            self._in = "h1"; self._buf = []
        elif tag == "h2":
            self._in = "h2"; self._buf = []
        elif tag == "meta":
            name = (a.get("name") or "").lower()
            prop = (a.get("property") or "").lower()
            if name == "description":
                self.meta_desc = a.get("content", "")[:400]
            elif prop.startswith("og:") or name.startswith("twitter:"):
                self.og[prop or name] = (a.get("content") or "")[:300]
        elif tag == "a" and a.get("href"):
            self._href = a["href"]; self._link_text = []
        elif tag == "script" and (a.get("type") or "").endswith("ld+json"):
            self.has_jsonld = True

    def handle_endtag(self, tag):
        if tag == self._in:
            text = " ".join("".join(self._buf).split())
            if self._in == "title" and not self.title:
                self.title = text
            elif self._in == "h1" and text:
                self.h1.append(text[:200])
            elif self._in == "h2" and text:
                self.h2.append(text[:200])
            self._in = None
        if tag == "a" and self._href is not None:
            t = " ".join("".join(self._link_text).split())[:160]
            if t:
                self.links.append((self._href, t))
            self._href = None

    def handle_data(self, data):
        if self._in:
            self._buf.append(data)
        if self._href is not None:
            self._link_text.append(data)


PRICE_RE = re.compile(r"(\d{1,4}(?:[.,]\d{1,2})?)\s?(€|\$|EUR|USD|CHF)\b", re.I)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]{2,}")
SOCIAL_DOMAINS = {
    "twitter.com": "twitter", "x.com": "twitter", "instagram.com": "instagram",
    "tiktok.com": "tiktok", "linkedin.com": "linkedin", "youtube.com": "youtube",
    "facebook.com": "facebook", "pinterest.com": "pinterest", "reddit.com": "reddit",
    "discord.gg": "discord", "t.me": "telegram", "github.com": "github",
}
STOPWORDS = {
    "le", "la", "les", "de", "des", "du", "un", "une", "et", "ou", "pour", "avec", "sur",
    "dans", "votre", "vous", "nous", "ce", "cette", "qui", "que", "quoi", "comment",
    "pourquoi", "est", "sont", "plus", "tout", "tous", "the", "of", "to", "and", "your",
    "for", "with", "what", "how", "why", "is", "are", "our", "we", "you", "a", "an",
}


def parse_html_file(path: str) -> PageParser:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            content = f.read(400_000)
        p = PageParser()
        p.feed(content)
        return p
    except Exception:
        return PageParser()


def detect_manifests(repo: str) -> dict:
    manifests: dict = {"frameworks": [], "raw": {}}
    # package.json
    for root, dirs, files in os.walk(repo):
        if any(s in root for s in SKIP_DIRS):
            dirs[:] = []
            continue
        if "package.json" in files:
            try:
                with open(os.path.join(root, "package.json"), encoding="utf-8") as f:
                    pkg = json.load(f)
                manifests["raw"]["package.json"] = {
                    "name": pkg.get("name"), "description": pkg.get("description", "")[:200],
                    "scripts": sorted((pkg.get("scripts") or {}).keys())[:12],
                }
                deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
                for dep in deps:
                    fw = JS_FRAMEWORKS.get(dep) or JS_FRAMEWORKS.get(dep.split("/")[0])
                    if fw and fw not in manifests["frameworks"]:
                        manifests["frameworks"].append(fw)
            except Exception:
                pass
        if "requirements.txt" in files:
            try:
                with open(os.path.join(root, "requirements.txt"), encoding="utf-8") as f:
                    reqs = [l.strip().lower() for l in f if l.strip() and not l.startswith("#")]
                manifests["raw"]["requirements.txt"] = reqs[:25]
                for line in reqs:
                    name = re.split(r"[<>=\[\s]", line)[0]
                    fw = PY_FRAMEWORKS.get(name)
                    if fw and fw not in manifests["frameworks"]:
                        manifests["frameworks"].append(fw)
            except Exception:
                pass
        for marker, label in [("Dockerfile", "Docker"), ("docker-compose.yml", "Docker Compose"),
                              ("vercel.json", "Vercel"), ("netlify.toml", "Netlify"),
                              ("wrangler.toml", "Cloudflare Workers")]:
            if marker in files and label not in manifests["frameworks"]:
                manifests["frameworks"].append(label)
        # pyproject
        if "pyproject.toml" in files:
            try:
                with open(os.path.join(root, "pyproject.toml"), encoding="utf-8", errors="replace") as f:
                    t = f.read(20_000).lower()
                for name, fw in PY_FRAMEWORKS.items():
                    if name in t and fw not in manifests["frameworks"]:
                        manifests["frameworks"].append(fw)
            except Exception:
                pass
        if len(manifests["raw"]) > 8:
            break
    return manifests


def scan_repo(repo: str) -> dict:
    """Analyse statique complète du dépôt."""
    langs: Counter = Counter()
    html_files: list[str] = []
    readme_path = None
    n_files = 0
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            if n_files >= MAX_FILES:
                break
            n_files += 1
            ext = os.path.splitext(fn)[1].lower()
            if ext in LANG_MAP:
                langs[LANG_MAP[ext]] += 1
            if ext in (".html", ".htm"):
                html_files.append(os.path.join(root, fn))
            if readme_path is None and fn.lower().startswith("readme"):
                readme_path = os.path.join(root, fn)
    # heuristique : la landing page = le HTML le plus "riche" en h1/metas
    best, best_score = None, -1
    for hp in html_files[:60]:
        p = parse_html_file(hp)
        score = len(p.h1) * 2 + len(p.h2) + (2 if p.meta_desc else 0) + (1 if p.og else 0)
        depth = hp[len(repo):].count(os.sep)
        score -= depth  # préférer les pages proches de la racine
        if score > best_score:
            best, best_score = (hp, p), score
    page = best[1] if best else PageParser()
    # README
    readme_excerpt, readme_urls, readme_title = "", [], ""
    if readme_path:
        try:
            with open(readme_path, encoding="utf-8", errors="replace") as f:
                md_txt = f.read(12_000)
            m = re.search(r"^#\s+(.+)$", md_txt, re.M)
            readme_title = m.group(1).strip() if m else ""
            readme_excerpt = md_txt[:2500]
            for u in re.findall(r"https?://[^\s)\]\"'>]+", md_txt):
                u = u.rstrip(".,;:")
                host = (urlparse(u).netloc or "").lower()
                if host and not any(b in host for b in ("github.com", "shields.io", "npmjs.com", "pypi.org", "badge", "opensource.org", "mit-license")):
                    readme_urls.append(u)
        except Exception:
            pass
    readme_urls = list(dict.fromkeys(readme_urls))[:8]
    # emails & prix (page + readme)
    blob = " ".join([page.title, page.meta_desc, " ".join(page.h1 + page.h2), readme_excerpt[:1500]])
    prices = [f"{m.group(1)} {m.group(2)}" for m in PRICE_RE.finditer(blob)][:6]
    emails = list(dict.fromkeys(EMAIL_RE.findall(readme_excerpt)))[:4]
    socials: dict[str, str] = {}
    for href, _t in list(page.links[:150]) + [(u, "") for u in readme_urls]:
        host = (urlparse(href).netloc or "").lower()
        for dom, name in SOCIAL_DOMAINS.items():
            if dom in host and name not in socials:
                socials[name] = href
                break
    for u in readme_urls:
        host = (urlparse(u).netloc or "").lower()
        for dom, name in SOCIAL_DOMAINS.items():
            if dom in host and name not in socials:
                socials[name] = u
                break
    # URL du site (priorité: og:url > 1re URL readme non-repo > domaine du 1er email)
    site_url = page.og.get("og:url") or ""
    if not site_url and readme_urls:
        site_url = readme_urls[0]
    if not site_url and emails:
        dom = emails[0].split("@")[1]
        if dom not in ("gmail.com", "proton.me", "outlook.com", "yahoo.com"):
            site_url = f"https://{dom}"
    # mots-clés de catégorie (mots fréquents des h1/h2/description, hors stopwords)
    words = re.findall(r"[a-zà-ÿ]{4,}", (page.title + " " + page.meta_desc + " " + " ".join(page.h1 + page.h2) + " " + readme_excerpt[:2000]).lower())
    category_words = [w for w, _c in Counter(words).most_common(25) if w not in STOPWORDS][:10]
    # CTAs : textes de liens contenant des verbes d'action
    cta_words = ("recevoir", "commencer", "essai", "start", "get", "buy", "acheter", "commander",
                 "essayer", "créer", "create", "sign up", "rejoindre", "join", "réserver", "book",
                 "télécharger", "download", " commander", "s'abonner", "subscribe")
    ctas = [t for _h, t in page.links if any(w in t.lower() for w in cta_words)][:8]

    raw_brand = (page.title.split("|")[0].split("—")[0].split("–")[0].strip() or readme_title.split("|")[0].strip()
                 or os.path.basename(repo.rstrip("/")).replace("-", " ").title())
    # si le titre est "X — Y" ou "X | Y", exclure les segments génériques (swarm, gtm, cockpit…)
    GENERIC = {"gtm", "swarm", "cockpit", "dashboard", "platform", "docs", "doc", "readme", "app", "site", "web", "official"}
    segs = [s.strip(" \t🌙⭐✨•·-–—|>") for s in re.split(r"[—–|:]", page.title or readme_title or "") if s.strip(" \t🌙⭐✨•·-–—|>")]
    good = [s for s in segs if s.lower().split() and not all(w in GENERIC for w in re.findall(r"[a-zà-ÿ]+", s.lower()))]
    if len(good) >= 1 and len(segs) >= 2:
        raw_brand = min(good, key=len)[:60]
    raw_brand = re.sub(r"^[^\wÀ-ÿ]+", "", raw_brand).strip()
    brand = raw_brand[:80]

    return {
        "scanned_at": now_iso(),
        "repo_path": repo,
        "n_files": n_files,
        "languages": dict(langs.most_common(12)),
        "manifests": detect_manifests(repo),
        "brand": {
            "guess": brand[:80],
            "html_title": page.title[:200],
            "meta_description": page.meta_desc,
            "og": page.og,
        },
        "product": {
            "taglines_h1": page.h1[:8],
            "value_props_h2": page.h2[:14],
            "ctas": ctas,
            "prices": prices,
            "emails": emails,
            "socials": socials,
            "category_words": category_words,
        },
        "site_url": site_url[:200],
        "readme": {"path": os.path.relpath(readme_path, repo) if readme_path else None,
                   "title": readme_title[:120], "excerpt": readme_excerpt,
                   "external_urls": readme_urls},
    }


def run(source: str, stack_dir: str) -> dict:
    """Pipeline d'analyse complet : préparation + scan + écriture des artefacts."""
    workdir = os.path.join(stack_dir, "repo")
    os.makedirs(workdir, exist_ok=True)
    repo, mode = prepare_repo(source, workdir)
    analysis = scan_repo(repo)
    analysis["source"] = redact_git_url(source)
    analysis["source_mode"] = mode
    ctx_dir = os.path.join(stack_dir, "context")
    os.makedirs(ctx_dir, exist_ok=True)
    with open(os.path.join(ctx_dir, "repo-analysis.json"), "w", encoding="utf-8") as f:
        json.dump(analysis, f, ensure_ascii=False, indent=1)
    return analysis


if __name__ == "__main__":
    src = sys.argv[1]
    dest = sys.argv[2]
    result = run(src, dest)
    print(json.dumps(result, ensure_ascii=False, indent=1)[:3000])
