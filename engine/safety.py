"""Garde-fous V1 : bind, jeton, chemins, URLs.

Point unique pour les contrôles de sécurité du runtime actuel.
Un futur routeur de providers (V2) pourra s'appuyer sur les mêmes règles
sans changer le modèle de données.
"""
from __future__ import annotations

import hmac
import ipaddress
import os
import re
import socket
import zipfile
from urllib.parse import urlparse

_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_SCP_GIT = re.compile(
    r"^git@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?):([A-Za-z0-9][A-Za-z0-9._/-]{0,400})$"
)
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
_DENIED_HOSTS = {
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
    "metadata.internal",
}
_DENIED_SUFFIXES = (".local", ".localhost", ".internal")
MAX_ZIP_FILES = 5000
MAX_ZIP_BYTES = 200 * 1024 * 1024


def bind_host() -> str:
    """Adresse d'écoute. Défaut loopback ; QEYNOX_BIND pour un conteneur."""
    raw = (os.environ.get("QEYNOX_BIND") or "127.0.0.1").strip()
    return raw or "127.0.0.1"


def is_loopback(host: str) -> bool:
    h = (host or "").strip().lower()
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    if h in _LOOPBACK_HOSTS or h.startswith("127."):
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


def api_token() -> str:
    return (os.environ.get("QEYNOX_API_TOKEN") or "").strip()


def legacy_hook_token() -> str:
    return (os.environ.get("GTM_HOOK_TOKEN") or "").strip()


def accepted_tokens() -> list[str]:
    out: list[str] = []
    for token in (api_token(), legacy_hook_token()):
        if token and token not in out:
            out.append(token)
    return out


def tokens_equal(presented: str | None, expected: str) -> bool:
    left = (presented or "").encode("utf-8")
    right = expected.encode("utf-8")
    if len(left) != len(right):
        hmac.compare_digest(right, right)
        return False
    return hmac.compare_digest(left, right)


def token_accepted(presented: str | None) -> bool:
    tokens = accepted_tokens()
    if not tokens:
        return True
    return any(tokens_equal(presented, token) for token in tokens)


def assert_bind_allowed(host: str | None = None) -> None:
    """Refuse de s'exposer hors loopback sans jeton (fail closed)."""
    host = bind_host() if host is None else host
    if is_loopback(host) or accepted_tokens():
        return
    raise SystemExit(
        "Refus de démarrer : QEYNOX_BIND n'est pas une adresse loopback "
        f"({host}) et QEYNOX_API_TOKEN est vide. "
        "Définissez un jeton, ou laissez QEYNOX_BIND=127.0.0.1."
    )


def safe_slug(slug: str) -> str:
    slug = (slug or "").strip()
    if not _SLUG.fullmatch(slug):
        raise ValueError("slug invalide")
    return slug


def safe_join(root: str, *parts: str) -> str:
    """Joint un chemin et garantit qu'il reste sous root (realpath)."""
    if not parts:
        raise ValueError("chemin vide")
    root_abs = os.path.realpath(root)
    cleaned: list[str] = []
    for part in parts:
        if not isinstance(part, str) or "\x00" in part:
            raise ValueError("chemin invalide")
        cleaned.append(part)
    candidate = os.path.abspath(os.path.join(root_abs, *cleaned))
    candidate_real = os.path.realpath(candidate)
    try:
        common = os.path.commonpath([root_abs, candidate_real])
    except ValueError as exc:
        raise ValueError("chemin hors racine") from exc
    if common != root_abs:
        raise ValueError("chemin hors racine")
    return candidate_real


def safe_cli_value(value: str, *, max_len: int = 200, field: str = "valeur") -> str:
    """Valeur d'argument CLI : pas d'option injectée, pas de contrôle."""
    if not isinstance(value, str):
        raise ValueError(f"{field} invalide")
    if any(ch in value for ch in ("\x00", "\n", "\r")):
        raise ValueError(f"{field} invalide")
    value = value.strip()
    if not value or len(value) > max_len:
        raise ValueError(f"{field} invalide")
    if value.startswith("-"):
        raise ValueError(f"{field} refusé")
    return value


def safe_geo(value: str | None) -> str:
    geo = (value or "FR").strip().upper()
    if not re.fullmatch(r"[A-Z]{2}", geo):
        raise ValueError("geo invalide")
    return geo


def validate_git_url(source: str) -> str:
    """N'autorise que https/http et la forme scp git@host:path.

    Bloque ext::, file:, les options déguisées en URL, et les chemins `..`.
    """
    source = (source or "").strip()
    if not source or len(source) > 500:
        raise ValueError("URL git refusée")
    if source.startswith("-") or any(ch in source for ch in ("\x00", "\n", "\r", "\t", " ", "\\")):
        raise ValueError("URL git refusée")
    lowered = source.lower()
    if lowered.startswith("ext:") or "ext::" in lowered or lowered.startswith(("file:", "git:", "ssh:")):
        raise ValueError("URL git refusée")
    if lowered.startswith(("http://", "https://")):
        parsed = urlparse(source)
        host = (parsed.hostname or "").lower()
        if parsed.scheme not in ("http", "https") or not host or host.startswith("-"):
            raise ValueError("URL git refusée")
        if parsed.username or parsed.password:
            raise ValueError("URL git refusée")
        if not parsed.path or parsed.path == "/":
            raise ValueError("URL git refusée")
        if any(seg == ".." for seg in parsed.path.split("/")):
            raise ValueError("URL git refusée")
        return source
    match = _SCP_GIT.fullmatch(source)
    if not match:
        raise ValueError("URL git refusée")
    path = match.group(2)
    if any(seg == ".." for seg in path.split("/")):
        raise ValueError("URL git refusée")
    return source


def _ip_blocked(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return not ip.is_global


def _host_denied(host: str) -> bool:
    host = host.lower().rstrip(".")
    if host in _DENIED_HOSTS or host.endswith(_DENIED_SUFFIXES):
        return True
    return False


def validate_public_http_url(url: str, *, resolve: bool = True) -> str:
    """http(s) vers une cible publique. Refuse loopback, lien-local, RFC1918.

    `resolve=False` ne fait pas de DNS (contrôle de forme + IP littérales).
    `resolve=True` refuse aussi un nom qui se résout vers une adresse non publique.
    """
    raw = (url or "").strip()
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("URL refusée")
    if parsed.username or parsed.password:
        raise ValueError("URL refusée")
    host = parsed.hostname
    if _host_denied(host):
        raise ValueError("URL refusée")
    literal: ipaddress.IPv4Address | ipaddress.IPv6Address | None
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if _ip_blocked(literal):
            raise ValueError("URL refusée")
        return raw
    if not resolve:
        return raw
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("URL refusée") from exc
    ips: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for info in infos:
        addr = info[4][0]
        try:
            ips.append(ipaddress.ip_address(addr.split("%", 1)[0]))
        except ValueError:
            continue
    if not ips or any(_ip_blocked(ip) for ip in ips):
        raise ValueError("URL refusée")
    return raw


def safe_extract_zip(zip_path: str, dest: str) -> None:
    """Extrait une archive en refusant les chemins qui sortent de dest."""
    dest_abs = os.path.realpath(dest)
    os.makedirs(dest_abs, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ZIP_FILES:
            raise RuntimeError("archive refusée : trop de fichiers")
        total = 0
        for info in infos:
            name = info.filename.replace("\\", "/")
            if name.startswith("/") or name.startswith("../") or "/../" in f"/{name}" or name in {"..", "../"}:
                raise RuntimeError(f"archive refusée : {info.filename}")
            mode = (info.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                raise RuntimeError(f"archive refusée : lien symbolique {info.filename}")
            target = os.path.realpath(os.path.join(dest_abs, name))
            try:
                common = os.path.commonpath([dest_abs, target])
            except ValueError as exc:
                raise RuntimeError(f"archive refusée : {info.filename}") from exc
            if common != dest_abs:
                raise RuntimeError(f"archive refusée : {info.filename}")
            total += info.file_size
            if total > MAX_ZIP_BYTES:
                raise RuntimeError("archive refusée : trop volumineuse")
        archive.extractall(dest_abs)
