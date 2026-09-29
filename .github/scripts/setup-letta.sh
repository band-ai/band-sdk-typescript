#!/usr/bin/env bash
# A self-hosted Letta server (docker) for the baseline's letta adapter, in steps
# so it boots while the job does other work:
#   setup-letta.sh start  - pull and start the container (needs ANTHROPIC_API_KEY,
#                           the server's own model key; the model is the
#                           ANTHROPIC_MODEL of tests/baseline/toolkit/adapters.ts)
#   setup-letta.sh wait   - wait until it is healthy, then export LETTA_BASE_URL
#   setup-letta.sh logs   - save the container log to $RUNNER_TEMP/letta/server.log
#   setup-letta.sh stop   - remove the container
#
# Unlike band-sdk-python's setup-letta.sh, no MCP URL-guard patch and no
# host-gateway: the TS adapter hands Letta the Band tools as client tools and
# runs them itself, so Letta never calls back into the runner. And no
# LETTA_NO_DEFAULT_ACTOR: the TS client sends no actor, so that flag would
# fail every call.
set -euo pipefail

# Pinned to the digest band-sdk-python validated (letta 0.16.8); the image is
# mutable upstream. Bump deliberately: update the pin, re-run the lane.
LETTA_IMAGE="letta/letta:0.16.8@sha256:aa66c3eeee13d2dfc40c650d709b550237ee31bfc91942a52fa488a13fa8c102"
LETTA_PORT=8283
LETTA_URL="http://localhost:${LETTA_PORT}"
LETTA_CONTAINER=letta-server

start() {
  # Loopback only: the tests run on this host, and the test server is unauthenticated.
  docker run -d --name "$LETTA_CONTAINER" \
    -p "127.0.0.1:${LETTA_PORT}:8283" \
    -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required for the Letta server}" \
    "$LETTA_IMAGE"
}

# Fail loudly if it never comes up, rather than let the tests fail opaquely.
# --max-time keeps one hung response from wedging the loop; a container that
# exited stops the wait at once.
wait_healthy() {
  for _ in $(seq 1 45); do
    if curl -fsS --max-time 5 "${LETTA_URL}/v1/health/" 2>/dev/null; then
      echo "LETTA_BASE_URL=${LETTA_URL}" >> "$GITHUB_ENV"
      return 0
    fi
    [ "$(docker inspect -f '{{.State.Running}}' "$LETTA_CONTAINER")" = true ] || break
    sleep 2
  done
  echo "Letta server did not become healthy on :${LETTA_PORT}" >&2
  docker logs "$LETTA_CONTAINER" 2>&1 | tail -50 || true
  return 1
}

# The container is removed on `stop`, and its log with it: save it first.
save_logs() {
  local dir="${RUNNER_TEMP}/letta"
  mkdir -p "$dir"
  docker logs "$LETTA_CONTAINER" > "$dir/server.log" 2>&1 || true
}

case "${1:-}" in
  start) start ;;
  wait) wait_healthy ;;
  logs) save_logs ;;
  stop) docker rm -f "$LETTA_CONTAINER" || true ;;
  *) echo "usage: $0 start|wait|logs|stop" >&2; exit 2 ;;
esac
