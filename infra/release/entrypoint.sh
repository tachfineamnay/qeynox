#!/bin/sh
set -eu
role="${1:?application role required}"
node /workspace/infra/release/check.mjs "$role"
# exec is essential: do not hide the worker behind pnpm/corepack/tsx process chains.
cd "/workspace/apps/$role"
case "$role" in
  api) exec node --import tsx /workspace/apps/api/src/main.ts ;;
  worker) exec node --import tsx /workspace/apps/worker/src/main.ts ;;
  web) exec node /workspace/apps/web/node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port 3000 ;;
  control) exec node /workspace/apps/control/node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port 3001 ;;
  *) echo 'Unknown release application role' >&2; exit 1 ;;
esac
