#!/bin/sh
set -e

# Fix ownership of volume-mounted directories that Docker initializes as root
chown -R appuser:appuser /home/appuser/.claude 2>/dev/null || true

# Restore .claude.json from backup if the container was rebuilt and the file was lost
CLAUDE_JSON="/home/appuser/.claude.json"
BACKUP_DIR="/home/appuser/.claude/backups"
if [ ! -f "$CLAUDE_JSON" ] && [ -d "$BACKUP_DIR" ]; then
  LATEST_BACKUP=$(ls -t "${BACKUP_DIR}"/.claude.json.backup.* 2>/dev/null | head -1)
  if [ -n "$LATEST_BACKUP" ]; then
    cp "$LATEST_BACKUP" "$CLAUDE_JSON"
    chown appuser:appuser "$CLAUDE_JSON"
  fi
fi

# Ensure the database directory exists (derived from DATABASE_URL env var)
DB_PATH="${DATABASE_URL#file:}"
DB_DIR="$(dirname "$DB_PATH")"
mkdir -p "$DB_DIR" 2>/dev/null || true
chown -R appuser:appuser "$DB_DIR" 2>/dev/null || true

exec gosu appuser "$@"
