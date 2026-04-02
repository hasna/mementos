#!/usr/bin/env bash
set -euo pipefail

REPO="/home/hasna/workspace/hasna/opensource/opensourcedev/open-mementos"
LOG="$REPO/.scripts/sync.log"

cd "$REPO"

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') ==="

  # Commit any uncommitted changes
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -m "chore: auto-commit uncommitted changes before sync"
    echo "Committed local changes"
  else
    echo "No local changes to commit"
  fi

  # Pull latest from GitHub
  git pull --rebase
  echo "Pulled latest from GitHub"

  # Checkpoint mementos WAL to prevent corruption from long-running MCP processes
  DB_PATH="$HOME/.hasna/mementos/mementos.db"
  if [ -f "$DB_PATH" ]; then
    sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null && echo "WAL checkpointed" || echo "WAL checkpoint failed (DB may be busy)"
  fi

  echo "=== done ==="
  echo ""
} >> "$LOG" 2>&1
