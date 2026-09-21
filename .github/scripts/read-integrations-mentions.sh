#!/usr/bin/env bash
# The Python SDK's nightly owns the integrations roster. Keep this report on
# that same roster instead of duplicating a second list that can drift.
set -euo pipefail

mentions=$(gh api repos/band-ai/band-sdk-python/contents/.github/integrations-team.txt --jq .content \
  | base64 --decode \
  | grep -vE '^\s*(#|$)' \
  | sed 's/^/@/' \
  | paste -sd ' ' - || true)
if [ -z "$mentions" ]; then
  echo "::error::The integrations roster is empty or unavailable."
  exit 1
fi

echo "mentions=$mentions" >> "$GITHUB_OUTPUT"
