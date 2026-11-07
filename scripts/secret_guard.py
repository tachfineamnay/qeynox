#!/usr/bin/env python3
"""Signale les secrets évidents dans les fichiers suivis par git."""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("private-key", re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github-token", re.compile(r"\bghp_[A-Za-z0-9]{20,}\b")),
    ("github-pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}")),
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("git-url-credentials", re.compile(r"https?://[^/\s:@]+:[^/\s@]{8,}@")),
]


def scan_text(text: str) -> list[tuple[str, int]]:
    hits: list[tuple[str, int]] = []
    for lineno, line in enumerate(text.splitlines(), 1):
        for name, pattern in PATTERNS:
            if pattern.search(line):
                hits.append((name, lineno))
    return hits


def tracked_files(root: Path) -> list[str]:
    proc = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    return [part.decode() for part in proc.stdout.split(b"\0") if part]


def scan_repo(root: Path) -> list[str]:
    found: list[str] = []
    for rel in tracked_files(root):
        path = root / rel
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for name, lineno in scan_text(text):
            found.append(f"{rel}:{lineno}: {name}")
    return found


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    found = scan_repo(root)
    if found:
        print("secrets détectés:", file=sys.stderr)
        print("\n".join(found), file=sys.stderr)
        return 1
    print(f"secret guard ok ({len(tracked_files(root))} fichiers suivis)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
