# Superseded: fixed-range 0012–0017 migration procedure

Do **not** use the former generated-SQL procedure for a current release. The migration set has grown;
a fixed 17-file manifest and a single generated transaction are not the current operator protocol.
`infra/scripts/generate-upgrade-0012-0017.py` now refuses to emit SQL rather than offering an unsafe
alternative runner.

Use [DATABASE_RELEASE.md](DATABASE_RELEASE.md): dynamic discovery through the existing checksum/lock/
per-file-transaction engine, read-only preflight and dry-run, exact target and backup confirmation,
reviewed plan digest, controlled apply/resume and backup/restore recovery. It supports populated
prefixes, including databases previously migrated through 0011 or 0017, without rewriting their history.

No migration is run automatically at startup. This redirect is not live-upgrade authorization or
proof of a current backup/restore rehearsal. Historical verification reports remain historical.
