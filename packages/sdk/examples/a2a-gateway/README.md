# `a2a-gateway/` — expose Thenvoi peers as A2A endpoints

Inverse of `a2a-bridge/`. This script publishes your existing Thenvoi peer agents *as* [A2A](https://github.com/agentcommunity/a2a) endpoints. Anything that speaks A2A — Claude Code, another Thenvoi bridge, an A2A client library — can then call your Thenvoi agents over JSON-RPC + SSE.

Use this when you want Thenvoi to be the *source of truth* for an agent and other tools to be able to invoke it externally.

## What it shows

- Wiring `A2AGatewayAdapter` with a direct REST client (the gateway needs REST access for peer metadata, not just the WebSocket)
- Choosing a listening port and an auth token for inbound A2A calls
- Reusing `linkOptions.restApi` so the agent runtime and the gateway adapter share one REST client

## Files

| File | What it does |
|------|--------------|
| `a2a-gateway-agent.ts` | The gateway agent — connects to Thenvoi, serves A2A on a port. |

## Prerequisites

- Node 20+, pnpm
- A Thenvoi agent registered in your workspace (the gateway connects as this agent)
- One or more Thenvoi peer agents you want to expose
- `agent_config.yaml`:

```yaml
a2a_gateway_agent:
  agent_id: "<gateway agent UUID>"
  api_key: "<gateway agent's Thenvoi API key>"
```

Optional env:

```bash
export GATEWAY_PORT=4000                   # which port to listen on
export GATEWAY_URL=https://your-host:4000  # public URL clients should hit (for advertised metadata)
export A2A_GATEWAY_AUTH_TOKEN=...          # token A2A callers must present; defaults to the Thenvoi API key
```

## Run

```bash
pnpm --dir packages/sdk exec tsx examples/a2a-gateway/a2a-gateway-agent.ts
```

You should see the gateway bind a port and the agent connect to Thenvoi.

## What "working" looks like

1. The gateway prints something like `gateway listening on http://0.0.0.0:4000`.
2. From an A2A client (or `curl`), call the gateway's `agent.json` discovery endpoint and you'll see your Thenvoi peers listed.
3. Send an A2A `message/send` to one of those peer URLs and watch:
   - The gateway forwards the turn to the Thenvoi peer.
   - Thenvoi peer events stream back as SSE `status_update`s.
   - The peer's final reply comes back as the A2A response message.

A complete loop: pair this with `examples/a2a-bridge/a2a-bridge-auth.ts` pointed at your gateway URL and use `A2A_BEARER_TOKEN=<your gateway auth token>`. The bridge will then post into a Thenvoi room what amounts to "a peer agent talking to its own gateway-published self."

## Common errors

| Error | Cause |
|-------|-------|
| `EADDRINUSE` | Pick a different `GATEWAY_PORT` |
| 401 from A2A clients | They're not sending the right token — match what you set as `A2A_GATEWAY_AUTH_TOKEN` |
| Discovery returns no peers | The gateway's REST client can't list peers; verify the Thenvoi agent has peer-list permission and there are peers in your workspace |

## Related

- `examples/a2a-bridge/` — the inverse direction (consume an external A2A agent inside Thenvoi)
