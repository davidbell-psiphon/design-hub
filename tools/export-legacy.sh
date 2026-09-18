#!/usr/bin/env bash
# §13 step 2 — dump every table the cleanup would drop, to JSON, for committing.
#
#   bash tools/export-legacy.sh
#
# Read-only. Runs under Git Bash on Windows, like the rest of the docs.
#
# This is the difference between a reversible change and a lost afternoon, so
# it refuses to produce a half-dump: a table that errors stops the script
# rather than leaving a file that looks like an export and is not one.
#
# `brands` is deliberately not in the list. §13 names it, but no such table
# ever existed — brand identity lived in `projects` under section_id='brands',
# and piece10-schema.sql is what gives it a real one. See
# README-CLEANUP-AUDIT.md.
set -euo pipefail

DB="design-hub"
OUT="legacy-export"
TABLES="chats resources capabilities projects sections auth sessions rate_limits"

mkdir -p "$OUT"

echo "Exporting from the REMOTE $DB database. Nothing is written to it."
echo

for t in $TABLES; do
  printf '  %-14s ' "$t"

  # A table that is not there is not a failure — §13's list was written from
  # memory of the old product, and `brands` was already wrong once.
  if ! npx wrangler d1 execute "$DB" --remote --json \
        --command "SELECT name FROM sqlite_master WHERE type='table' AND name='$t'" \
        2>/dev/null | grep -q "\"$t\""; then
    echo "not present — skipped"
    continue
  fi

  npx wrangler d1 execute "$DB" --remote --json \
    --command "SELECT * FROM $t" > "$OUT/$t.json"

  rows=$(node -e "
    const d = require('fs').readFileSync('$OUT/$t.json','utf8');
    try { const j = JSON.parse(d); console.log((j[0]?.results ?? []).length); }
    catch { console.log('?'); }
  ")
  echo "$rows rows -> $OUT/$t.json"
done

echo
echo "Done. Commit $OUT/ before anything is dropped."
