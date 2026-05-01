# `a2a-bridge/` — bridge a remote A2A agent into a Thenvoi room

Two scripts that take a remote [Agent2Agent](https://github.com/agentcommunity/a2a) (A2A) endpoint and put it into a Thenvoi room as a normal participant. Each Thenvoi room message is forwarded to the A2A endpoint as a turn; the streamed reply lands back in the room.

Use this when:
- Someone else has built an agent and exposed it over A2A — you want it in your Thenvoi rooms without rewriting it as a Thenvoi adapter
- You're paired with a teammate on the `a2a-gateway/` example and want to test their gateway from the outside

## What it shows

- `A2AAdapter` with `streaming: true` so partial replies arrive incrementally
- Auth wiring (API key / bearer token) for protected A2A endpoints

## Files

| File | What it does |
|------|--------------|
| `a2a-bridge-agent.ts` | Plain bridge — no auth |
| `a2a-bridge-auth.ts` | Same bridge with API key / bearer auth |

## Prerequisites

- Node 20+, pnpm
- A Thenvoi agent registered in your workspace
- A reachable A2A server URL — `A2A_AGENT_URL`
- `agent_config.yaml`:

```yaml
a2a_bridge_agent:
  agent_id: "<UUID>"
  api_key: "<Thenvoi agent API key>"

a2a_bridge_auth_agent:
  agent_id: "<UUID>"
  api_key: "<Thenvoi agent API key>"
```

For the auth variant:

```bash
export A2A_AGENT_URL=https://your-a2a-host/agent
export A2A_API_KEY=...        # if your endpoint takes an API key
export A2A_BEARER_TOKEN=...   # if it takes a bearer token (or both)
```

## Run

Plain:

```bash
export A2A_AGENT_URL=https://example.com/a2a
pnpm --dir packages/sdk exec tsx examples/a2a-bridge/a2a-bridge-agent.ts
```

With auth:

```bash
export A2A_AGENT_URL=https://example.com/a2a
export A2A_API_KEY=...
pnpm --dir packages/sdk exec tsx examples/a2a-bridge/a2a-bridge-auth.ts
```

## What "working" looks like

1. Process starts, no errors.
2. From a Thenvoi room the bridge agent is in, send a message.
3. The bridge forwards it as an A2A `message/send` request.
4. Streamed `status_update` events appear as Thenvoi events in the room.
5. The final A2A reply lands in the room as a normal chat message.

## Common errors

| Error | Cause |
|-------|-------|
| `A2A remote URL is required.` | `A2A_AGENT_URL` not set |
| `A2A 401 Unauthorized` | Auth headers missing or wrong — check `A2A_API_KEY` / `A2A_BEARER_TOKEN` |
| `A2A 404 Not Found` | Wrong path on the A2A server (`/agent` vs `/`, etc.) |
| Connects but nothing comes back | The A2A server isn't streaming, or it's returning an error in the SSE channel — check its logs |

## Related

- `examples/a2a-gateway/` — the inverse direction: expose Thenvoi peers *as* A2A endpoints other tools can call
