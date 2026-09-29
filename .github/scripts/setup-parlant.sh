#!/usr/bin/env bash
# A Parlant server in the background for the baseline's parlant adapter.
#   setup-parlant.sh start - start it (needs OPENAI_API_KEY, the server's NLP
#                            service), wait until it answers, then export
#                            PARLANT_ENVIRONMENT
#   setup-parlant.sh stop  - stop it by its pid
# Its state, log (server.log) and pid live under $RUNNER_TEMP/parlant.
set -euo pipefail

# Pinned to the version validated against the adapter. Bump deliberately.
PARLANT_VERSION="3.3.2"
export PARLANT_PORT=8800
PARLANT_URL="http://localhost:${PARLANT_PORT}"
PARLANT_DIR="${RUNNER_TEMP}/parlant"

start() {
  : "${OPENAI_API_KEY:?OPENAI_API_KEY is required for the Parlant server}"
  mkdir -p "$PARLANT_DIR"
  python -m pip install --quiet "parlant==${PARLANT_VERSION}"

  PARLANT_HOME="$PARLANT_DIR/home" nohup python "$(dirname "$0")/parlant-server.py" \
    > "$PARLANT_DIR/server.log" 2>&1 &
  local pid=$!
  echo "$pid" > "$PARLANT_DIR/pid"

  # Readiness is an API that answers: /healthz reports "unhealthy" under load
  # even while the server is serving. A server that died stops the wait at once.
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 5 -o /dev/null "${PARLANT_URL}/agents" 2>/dev/null; then
      echo "PARLANT_ENVIRONMENT=${PARLANT_URL}" >> "$GITHUB_ENV"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 2
  done
  echo "Parlant server did not become ready on :${PARLANT_PORT}" >&2
  tail -50 "$PARLANT_DIR/server.log" || true
  return 1
}

stop() {
  if [ -f "$PARLANT_DIR/pid" ]; then kill "$(cat "$PARLANT_DIR/pid")" || true; fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
