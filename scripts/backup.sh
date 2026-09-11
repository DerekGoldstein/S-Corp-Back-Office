#!/usr/bin/env bash
# Nightly encrypted backup (brief §6): pg_dump + vault tarball, AES-256
# encrypted with APP_ENCRYPTION_KEY, written to var/backups/ and optionally
# rclone'd to one cloud object store (owner configures BACKUP_RCLONE_REMOTE).
# Schedule: crontab -e →  15 2 * * *  cd /path/to/repo && bash scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC2046
export $(grep -E '^(DATABASE_URL|APP_ENCRYPTION_KEY|BACKUP_RCLONE_REMOTE)=' .env 2>/dev/null | xargs -d '\n' -I{} echo {} ) >/dev/null 2>&1 || true
: "${DATABASE_URL:=postgresql://postgres@localhost/scorp?host=/tmp/scorp-pg}"
if [ -z "${APP_ENCRYPTION_KEY:-}" ]; then
  echo "APP_ENCRYPTION_KEY not set (.env) — refusing to write an unencrypted backup" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="var/backups"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pg_dump --no-owner --dbname "$DATABASE_URL" > "$TMP/scorp.sql"
if [ -d var/vault ]; then tar -czf "$TMP/vault.tar.gz" -C var vault; fi
tar -czf "$TMP/backup.tar.gz" -C "$TMP" scorp.sql $( [ -f "$TMP/vault.tar.gz" ] && echo vault.tar.gz )

openssl enc -aes-256-cbc -pbkdf2 -salt \
  -pass "pass:$APP_ENCRYPTION_KEY" \
  -in "$TMP/backup.tar.gz" -out "$OUT/scorp-$STAMP.tar.gz.enc"

# retain 30 local backups
ls -1t "$OUT"/scorp-*.tar.gz.enc 2>/dev/null | tail -n +31 | xargs -r rm --

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  rclone copy "$OUT/scorp-$STAMP.tar.gz.enc" "$BACKUP_RCLONE_REMOTE"
fi

echo "backup written: $OUT/scorp-$STAMP.tar.gz.enc"
echo "restore: openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:\$APP_ENCRYPTION_KEY -in <file> | tar -xz"
