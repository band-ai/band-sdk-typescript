#!/usr/bin/env bash
set -e
RESP=$(curl -sS -X POST https://app.band.ai/api/v1/me/agents/register -H "X-API-Key: {{BAND_USER_API_KEY}}" -H "Content-Type: application/json" -d '{"agent":{"name":"MyOpenClawAgent","description":"OpenClaw agent on Band"}}')
read -r AGENT_ID AGENT_KEY < <(node -e 'const j=JSON.parse(require("fs").readFileSync(0));console.log(j.data.agent.id+" "+j.data.credentials.api_key);' <<<"$RESP")
openclaw plugins install @band-ai/openclaw-channel-band --force
openclaw channels add --channel openclaw-channel-band --account "$AGENT_ID" --token "$AGENT_KEY"
openclaw config set "channels.openclaw-channel-band.accounts.$AGENT_ID.agentId" "$AGENT_ID"
openclaw gateway restart
echo "Registered agent $AGENT_ID. Agent API key (shown once): $AGENT_KEY"