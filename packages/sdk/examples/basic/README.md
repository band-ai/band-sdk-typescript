# `basic/` — minimal echo agent

The smallest possible Thenvoi agent. Reads incoming messages and replies with `Echo: <message>`. Use this as the "hello world" to confirm your credentials and platform connectivity work end-to-end before reaching for an LLM-backed adapter.

## What it shows

- Building a `GenericAdapter` with a single async callback
- Calling `tools.sendMessage` with the required `mentions` array
- Wiring the adapter into `Agent.create` and calling `agent.run()`

If anything is broken in your setup, this example surfaces it with the smallest possible amount of moving parts.

## Files

| File | What it does |
|------|--------------|
| `basic-agent.ts` | The whole example — adapter + agent + CLI runner. ~50 lines. |

## Prerequisites

- Node 20+, pnpm
- A Thenvoi agent registered in your workspace
- An `agent_config.yaml` in the working directory you'll run the example from, with this shape:

```yaml
basic_agent:
  agent_id: "<the agent's UUID>"
  api_key: "<the agent's API key>"
  # Optional — only set these if you're not using the hosted defaults:
  # ws_url: "wss://app.thenvoi.com/api/v1/socket"
  # rest_url: "https://app.thenvoi.com"
```

## Run

```bash
pnpm --dir packages/sdk exec tsx examples/basic/basic-agent.ts
```

The process stays attached, listening on a WebSocket. Stop it with `Ctrl-C`.

## What "working" looks like

1. The process starts and prints no errors.
2. From a Thenvoi room the agent is a member of (or that you invite it to), send any message: `hello`.
3. The agent replies in the same room with: `@you Echo: hello`.

If you don't see step 3, check:

- The agent is actually a participant in the room you're posting from
- `agent_id` and `api_key` in your yaml match the agent (a 401 would surface in the process logs)
- Your network can reach `wss://app.thenvoi.com/api/v1/socket` (corporate proxies often block WebSocket upgrades)

## Common errors

| Error | Cause |
|-------|-------|
| `Config file not found: ./agent_config.yaml` | Run `tsx` from a directory that contains the yaml, or pass an explicit path |
| `Missing required fields in ./agent_config.yaml under key "basic_agent": agent_id, api_key` | Yaml is present but the section is empty or misnamed |
| `ThenvoiError: 401 unauthorized` (in logs) | API key doesn't match the agent ID |
