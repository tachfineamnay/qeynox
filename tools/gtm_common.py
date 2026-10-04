"""Utilitaires partagés des outils QeyNox.

Config env, client SearXNG JSON, extraction HTML, helpers CLI.
Importé par les scripts de tools/.
"""
from __future__ import annotations

import os
import re
import sys
import time
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import requests

DEFAULT_LANG = os.environ.get("GTM_LANG", "fr")
DEFAULT_GL = os.environ.get("GTM_GL", "FR")

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)


def searxng_url() -> str:
    return os.environ.get("SEARXNG_URL", "http://127.0.0.1:8888").rstrip("/")


def db_path() -> str:
    return os.environ.get("GTM_DB", "data/gtm.db")


def searx_search(
    query: str,
    categories: str = "general",
    engines: str | None = None,
    lang: str = DEFAULT_LANG,
    pages: int = 1,
    timeout: int = 25,
) -> list[dict]:
    """Interroge SearXNG (format json) et retourne une liste de résultats unifiés.

    Chaque résultat: {title, url, snippet, engine, category, published}
    """
    out: list[dict] = []
    for page in range(1, pages + 1):
        params = {
            "q": query,
            "format": "json",
            "language": lang,
            "categories": categories,
            "pageno": page,
        }
        if engines:
            params["engines"] = engines
        try:
            r = requests.get(
                f"{searxng_url()}/search", params=params,
                headers={"User-Agent": UA}, timeout=timeout,
            )
            r.raise_for_status()
            data = r.json()
        except requests.RequestException as exc:
            print(
                f"[searx] ERREUR ({exc}) — SearXNG tourne-il sur {searxng_url()} ?\n"
                f"        Démarrage: docker compose -f docker-compose.searxng.yml up -d",
                file=sys.stderr,
            )
            return out
        for res in data.get("results", []):
            out.append(
                {
                    "title": res.get("title", ""),
                    "url": res.get("url", ""),
                    "snippet": res.get("content", "") or "",
                    "engine": ",".join(res.get("engines", [])) or res.get("engine", ""),
                    "category": categories,
                    "published": res.get("publishedDate") or "",
                }
            )
        if not data.get("results"):
            break
        time.sleep(0.8)  # politesse envers les engines amont
    # dédoublonnage par URL
    seen: set[str] = set()
    uniq = []
    for r_ in out:
        if r_["url"] and r_["url"] not in seen:
            seen.add(r_["url"])
            uniq.append(r_)
    return uniq


def autocomplete(source: str, query: str, lang: str = DEFAULT_LANG, gl: str = DEFAULT_GL) -> list[str]:
    """Suggestions (autocomplete) sans clé API.

    sources: google | ddg | youtube
    """
    try:
        if source == "google":
            url = "https://suggestqueries.google.com/complete/search"
            r = requests.get(
                url,
                params={"client": "firefox", "hl": lang, "gl": gl, "q": query},
                headers={"User-Agent": UA},
                timeout=12,
            )
            return [s for s in r.json()[1] if isinstance(s, str)][:12]
        if source == "ddg":
            r = requests.get(
                "https://duckduckgo.com/ac/",
                params={"type": "list", "q": query},
                headers={"User-Agent": UA},
                timeout=12,
            )
            data = r.json()
            # format: [q, [suggestions]]
            return [s for s in (data[1] if isinstance(data, list) and len(data) > 1 else [])][:12]
        if source == "youtube":
            url = "https://suggestqueries.google.com/complete/search"
            r = requests.get(
                url,
                params={"client": "firefox", "ds": "yt", "hl": lang, "gl": gl, "q": query},
                headers={"User-Agent": UA},
                timeout=12,
            )
            return [s for s in r.json()[1] if isinstance(s, str)][:12]
    except (requests.RequestException, ValueError, IndexError, KeyError):
        return []
    return []


class _TextExtractor(HTMLParser):
    _SKIP = {"script", "style", "noscript", "svg", "head", "iframe"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0
        self.title = ""

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip += 1
        if tag == "title" and not self.title:
            self._in_title = True

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip:
            self._skip -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        t = data.strip()
        if not t or self._skip:
            return
        if getattr(self, "_in_title", False) and not self.title:
            self.title = t
        self.parts.append(t)


def _validate_public_http_url(url: str, *, resolve: bool = True) -> str:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if root not in sys.path:
        sys.path.insert(0, root)
    from engine.safety import validate_public_http_url
    return validate_public_http_url(url, resolve=resolve)


def safe_get(url: str, *, timeout: int = 20, headers: dict | None = None):
    """GET http(s) public, en validant chaque redirection."""
    headers = headers or {"User-Agent": UA}
    current = url
    response = None
    for _hop in range(5):
        _validate_public_http_url(current, resolve=True)
        response = requests.get(current, headers=headers, timeout=timeout, allow_redirects=False)
        if response.status_code not in (301, 302, 303, 307, 308):
            return response
        location = response.headers.get("Location")
        if not location:
            return response
        current = urljoin(current, location)
    raise ValueError("trop de redirections")


def fetch_text(url: str, timeout: int = 20) -> tuple[str, str]:
    """Télécharge une page et retourne (titre, texte visible)."""
    r = safe_get(url, timeout=timeout)
    r.raise_for_status()
    p = _TextExtractor()
    p.feed(r.text)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(p.parts))
    return p.title or url, text


def domain_of(url: str) -> str:
    try:
        return (urlparse(url).netloc or "").lower().replace("www.", "")
    except ValueError:
        return ""


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]


def ensure_dirs(*paths: str) -> None:
    for p in paths:
        os.makedirs(p, exist_ok=True)
