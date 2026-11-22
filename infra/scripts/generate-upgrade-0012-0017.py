#!/usr/bin/env python3
"""Retired fail-closed entrypoint. No SQL generation and no database access.

Use the shared TypeScript migration engine through `pnpm db:release`.
See infra/DATABASE_RELEASE.md for preflight, backup confirmation and resume.
"""
import sys

sys.exit('Retired fixed-range SQL generator. Use pnpm db:release; see infra/DATABASE_RELEASE.md. No SQL generated.')
