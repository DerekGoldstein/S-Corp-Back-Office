#!/usr/bin/env bash
# Local Postgres 16 for dev and tests.
#   socket dir: /tmp/scorp-pg   (short path — unix sockets have a 107-byte limit)
#   data dir:   var/pg/data     (or /var/tmp/scorp-pg-data when running as root,
#                                since postgres refuses to run as root and the
#                                postgres system user can't traverse $HOME)
# Works on the owner's machine as a normal user, and in the CCR container as root.
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN="${PGBIN:-}"
if [ -z "$PGBIN" ]; then
  for d in /usr/lib/postgresql/16/bin /usr/lib/postgresql/17/bin \
           /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin; do
    if [ -x "$d/pg_ctl" ]; then PGBIN="$d"; break; fi
  done
fi
if [ -z "$PGBIN" ]; then
  if command -v pg_ctl >/dev/null 2>&1; then PGBIN="$(dirname "$(command -v pg_ctl)")"; fi
fi
[ -n "$PGBIN" ] || { echo "pg_ctl not found; install Postgres 16 or set PGBIN" >&2; exit 1; }

SOCK="${SCORP_PG_SOCKET:-/tmp/scorp-pg}"
if [ "$(id -u)" = "0" ]; then
  DATA="${SCORP_PG_DATA:-/var/tmp/scorp-pg-data}"
  LOG="$(dirname "$DATA")/scorp-pg.log"
else
  DATA="${SCORP_PG_DATA:-$PWD/var/pg/data}"
  LOG="$PWD/var/pg/pg.log"
  mkdir -p var/pg
fi
mkdir -p "$SOCK" "$(dirname "$DATA")"

run() {
  if [ "$(id -u)" = "0" ]; then
    chown -R postgres "$SOCK" "$(dirname "$DATA")" 2>/dev/null || true
    su postgres -s /bin/bash -c "$1"
  else
    bash -c "$1"
  fi
}

case "${1:-}" in
  start)
    if [ ! -d "$DATA/base" ]; then
      run "'$PGBIN/initdb' -D '$DATA' -U postgres -A trust >/dev/null"
    fi
    run "'$PGBIN/pg_ctl' -D '$DATA' -o \"-k $SOCK -c listen_addresses=''\" -l '$LOG' start" || true
    run "'$PGBIN/pg_isready' -h '$SOCK' -U postgres -t 10" >/dev/null
    echo "postgres ready on $SOCK"
    ;;
  stop)
    run "'$PGBIN/pg_ctl' -D '$DATA' stop -m fast"
    ;;
  status)
    run "'$PGBIN/pg_ctl' -D '$DATA' status"
    ;;
  reset)
    "$0" stop >/dev/null 2>&1 || true
    run "rm -rf '$DATA'"
    "$0" start
    ;;
  ensure)
    if ! run "'$PGBIN/pg_isready' -h '$SOCK' -U postgres -t 2" >/dev/null 2>&1; then
      "$0" start
    fi
    ;;
  *)
    echo "usage: scripts/db.sh start|stop|status|reset|ensure" >&2
    exit 1
    ;;
esac
