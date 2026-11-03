#!/usr/bin/env bash
# Loads a vault folder into the LOCAL (simulated) R2 bucket so you can test with `wrangler dev`.
# Usage: bash scripts/seed-local.sh examples/sample-vault [bucket] [key-prefix]
set -euo pipefail
SRC="${1:?usage: seed-local.sh <vault-folder> [bucket] [key-prefix]}"
BUCKET="${2:-obsidian-vault}"
PREFIX="${3:-}"
cd "$(dirname "$0")/.."
count=0
while IFS= read -r -d '' f; do
  rel="${f#"$SRC"/}"
  npx --no-install wrangler r2 object put "$BUCKET/$PREFIX$rel" --file "$f" --content-type "text/markdown" --local >/dev/null
  count=$((count + 1))
done < <(find "$SRC" -type f -name '*.md' ! -name 'TEST-QUESTIONS.md' -print0)
echo "Seeded $count notes into local bucket '$BUCKET'."
