#!/usr/bin/env bash
# Start a Parlant server in the background for the baseline's parlant adapter.
#
# Reads OPENAI_API_KEY (the server's NLP service) and exports
# PARLANT_ENVIRONMENT to later steps. Its state, log and pid live under
# $RUNNER_TEMP/parlant; the teardown step stops it by that pid.
set -euo pipefail

# Pinned to the version validated against the adapter. Bump deliberately.
PARLANT_VERSION="3.3.2"
export PARLANT_PORT=8800
PARLANT_URL="http://localhost:${PARLANT_PORT}"
PARLANT_DIR="${RUNNER_TEMP}/parlant"

: "${OPENAI_API_KEY:?OPENAI_API_KEY is required for the Parlant server}"
mkdir -p "$PARLANT_DIR"
python -m pip install --quiet "parlant==${PARLANT_VERSION}"

PARLANT_HOME="$PARLANT_DIR/home" nohup python "$(dirname "$0")/parlant-server.py" \
  > "$PARLANT_DIR/server.log" 2>&1 &
echo $! > "$PARLANT_DIR/pid"

# Readiness is an API that answers: /healthz reports "unhealthy" under load
# even while the server is serving.
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 -o /dev/null "${PARLANT_URL}/agents"; then
    echo "PARLANT_ENVIRONMENT=${PARLANT_URL}" >> "$GITHUB_ENV"
    exit 0
  fi
  sleep 2
done
echo "Parlant server did not become ready on :${PARLANT_PORT}" >&2
tail -50 "$PARLANT_DIR/server.log" || true
exit 1
