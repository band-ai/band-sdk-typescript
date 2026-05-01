# `letta/` — Letta-backed agent

A Thenvoi agent that delegates each room message to a [Letta](https://letta.com) agent. Letta gives you persistent memory across conversations — useful when you want the agent to actually remember earlier rooms, customer histories, or learned facts.

Works against Letta Cloud (managed) or a self-hosted Letta server.

## What it shows

- Wiring `LettaAdapter` into `Agent.create`
- Configuring cloud-vs-self-hosted via env (`LETTA_API_KEY` or `LETTA_BASE_URL`)
- Provider-prefixed model IDs Letta uses (`openai/gpt-4o`, `anthropic/claude-...`)

## Files

| File | What it does |
|------|--------------|
| `letta-agent.ts` | Adapter + agent + CLI runner. ~60 lines. |

## Prerequisites

- Node 20+, pnpm
- A Thenvoi agent registered in your workspace
- A Letta agent (created in your Letta workspace) for the adapter to drive
- `agent_config.yaml`:

```yaml
letta_agent:
  agent_id: "<the Thenvoi agent's UUID>"
  api_key: "<the Thenvoi agent's API key>"
```

- One of these Letta env configs:

**Letta Cloud:**
```bash
export LETTA_API_KEY=...
export LETTA_MODEL=openai/gpt-4o   # optional
```

**Self-hosted:**
```bash
export LETTA_BASE_URL=http://localhost:8283
export LETTA_MODEL=openai/gpt-4o   # optional
```

## Run

```bash
pnpm --dir packages/sdk exec tsx examples/letta/letta-agent.ts
```

You'll see a startup banner with the resolved agent ID, model, and Letta target.

## What "working" looks like

1. Process prints its startup config and connects to Thenvoi without errors.
2. From a Thenvoi room the agent is in, send: `My favorite color is teal.`
3. The agent replies, acknowledging.
4. Send: `What's my favorite color?` later (even after process restart, since Letta memory is persistent).
5. The agent recalls "teal" via Letta's stored memories — proving the platform-vs-LLM persistence story.

## Common errors

| Error | Cause |
|-------|-------|
| `Set LETTA_API_KEY (cloud) or LETTA_BASE_URL (self-hosted) to run this example.` | Neither is set |
| Letta auth failure | Bad `LETTA_API_KEY` or unreachable `LETTA_BASE_URL` |
| Agent connects but Letta returns errors about model | The configured `LETTA_MODEL` isn't installed/configured in your Letta workspace |
