#!/bin/sh
# Démarre en root seulement pour rendre /data inscriptible, puis descend
# sur l'utilisateur qeynox (uid 10001). Le processus servi n'est jamais root.
set -eu
if [ "$(id -u)" = "0" ]; then
  stacks="${QEYNOX_STACKS_DIR:-/data/stacks}"
  logs="${QEYNOX_LOGS_DIR:-/data/logs}"
  missions="${QEYNOX_MISSIONS_FILE:-/data/missions.json}"
  mkdir -p "$stacks" "$logs" "$(dirname "$missions")"
  chown -R qeynox:qeynox /data
  exec setpriv --reuid=qeynox --regid=qeynox --init-groups -- "$@"
fi
exec "$@"
