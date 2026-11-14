#!/usr/bin/env python3
"""Generate a checksum-guarded 0012–0017 upgrade from committed Git blobs.

Output SQL is intended for psql with ON_ERROR_STOP. It never opens a database.
"""
import hashlib
import re
import subprocess
import sys

prefix = 'packages/persistence/migrations/'
names = subprocess.check_output(['git', 'ls-tree', '--name-only', 'HEAD', prefix], text=True).splitlines()
files = sorted(name for name in names if re.fullmatch(prefix + r'\d{4}_[a-z0-9_]+\.sql', name))
if len(files) != 17 or [name[len(prefix):len(prefix)+4] for name in files] != [f'{n:04d}' for n in range(1, 18)]:
    raise SystemExit('Expected exactly migrations 0001 through 0017 in HEAD')
blobs = [(name[len(prefix):], subprocess.check_output(['git', 'show', 'HEAD:' + name])) for name in files]
expected = ',\n'.join("('%s','%s')" % (name, hashlib.sha256(sql).hexdigest()) for name, sql in blobs[:11])
parts = [r'''\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('qeynox.schema_migrations'));
DO $guard$
BEGIN
  IF current_database() <> 'qeynox' THEN RAISE EXCEPTION 'Unexpected database'; END IF;
  IF EXISTS (
    (SELECT name, checksum FROM schema_migrations EXCEPT SELECT * FROM (VALUES
''' + expected + r''') AS expected(name, checksum))
    UNION ALL
    (SELECT * FROM (VALUES
''' + expected + r''') AS expected(name, checksum) EXCEPT SELECT name, checksum FROM schema_migrations)
  ) THEN RAISE EXCEPTION 'Migration ledger is not the exact 0001–0011 baseline'; END IF;
END $guard$;
''']
for name, sql in blobs[11:]:
    text = sql.decode('utf-8')
    if re.search(r'^\s*(BEGIN|COMMIT|ROLLBACK)\s*;', text, re.I | re.M):
        raise SystemExit('Migration controls its own transaction: ' + name)
    parts.append('\n-- ' + name + '\n' + text + '\n')
    parts.append("INSERT INTO schema_migrations(name, checksum) VALUES ('%s','%s');\n" % (name, hashlib.sha256(sql).hexdigest()))
parts.append('COMMIT;\n')
sys.stdout.buffer.write(''.join(parts).encode('utf-8'))
