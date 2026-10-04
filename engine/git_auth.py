"""Authentification optionnelle des clones https://github.com.

QEYNOX_GIT_TOKEN (PAT fine-grained, lecture seule) est transmis à git par
variables GIT_CONFIG_*, comme un en-tête Authorization limité à
https://github.com/. Il n'entre ni dans l'URL, ni dans l'argv, ni dans le
journal.
"""
from __future__ import annotations

import os
import re
from urllib.parse import urlparse

_TOKEN_RE = re.compile(r"^[A-Za-z0-9_\-]{8,}$")
_HEADER_KEY = "http.https://github.com/.extraHeader"


def git_token() -> str:
    return (os.environ.get("QEYNOX_GIT_TOKEN") or "").strip()


def token_usable(token: str) -> bool:
    return bool(_TOKEN_RE.fullmatch(token or ""))


def is_github_https(url: str) -> bool:
    parsed = urlparse(url or "")
    return parsed.scheme == "https" and (parsed.hostname or "").lower() == "github.com"


def redact(text: str, secret: str) -> str:
    if not text or not token_usable(secret):
        return text or ""
    return text.replace(secret, "***")


def apply_clone_auth(env: dict, url: str) -> str:
    """Prépare l'environnement du processus git. Retourne le secret à masquer.

    Le jeton est retiré de l'environnement enfant. Pour un clone
    https://github.com/ uniquement, il est replacé dans un extraHeader
    scopé à cet hôte.
    """
    token = (env.get("QEYNOX_GIT_TOKEN") or "").strip()
    env.pop("QEYNOX_GIT_TOKEN", None)
    if not token_usable(token):
        return ""
    if is_github_https(url):
        try:
            count = int(env.get("GIT_CONFIG_COUNT") or "0")
        except ValueError:
            count = 0
        if count < 0:
            count = 0
        env["GIT_CONFIG_COUNT"] = str(count + 1)
        env[f"GIT_CONFIG_KEY_{count}"] = _HEADER_KEY
        env[f"GIT_CONFIG_VALUE_{count}"] = f"Authorization: Bearer {token}"
    return token
