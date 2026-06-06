# `opencode/` — OpenCode-backed agent

A Thenvoi agent that forwards every room message into a running [OpenCode](https://github.com/opencode-ai/opencode) server. OpenCode is a self-hosted "Claude Code-style" coding agent that exposes an HTTP + SSE API. The adapter streams OpenCode's tool calls and approvals back into Thenvoi as events, then posts the final reply.

Use this when you want a coding agent that runs entirely on your hardware and you can swap the underlying model freely.

## What it shows

- Wiring `OpencodeAdapter` into `Agent.create`
- How tool calls / approvals / execution events from a backend agent become Thenvoi `task` and `thought` events
- Approval-mode handling (`manual`, `auto_accept`, `auto_decline`)

## Files

| File | What it does |
|------|--------------|
| `opencode-agent.ts` | Adapter + agent + CLI runner. ~80 lines. |

## Prerequisites

1. Install OpenCode and start the server (separate terminal, leave it running):
   ```bash
   npm install -g opencode-ai
   opencode serve --hostname=127.0.0.1 --port=4096
   ```
2. Node 20+, pnpm.
3. A Thenvoi agent registered in your workspace.
4. `agent_config.yaml`:
   ```yaml
   opencode_agent:
     agent_id: "<the agent's UUID>"
     api_key: "<the agent's Thenvoi API key>"
   ```

OpenCode tunables (all optional, defaults shown):

```bash
export OPENCODE_BASE_URL=http://127.0.0.1:4096
export OPENCODE_PROVIDER_ID=opencode
export OPENCODE_MODEL_ID=minimax-m2.5-free
# export OPENCODE_AGENT=                # OpenCode "agent" preset name
# export OPENCODE_APPROVAL_MODE=manual  # manual | auto_accept | auto_decline
```

## Run

```bash
pnpm --dir packages/sdk exec tsx examples/opencode/opencode-agent.ts
```

The agent connects to Thenvoi, subscribes to existing rooms, and forwards each message to OpenCode.

## What "working" looks like

1. The OpenCode server logs an inbound request when you message the Thenvoi agent.
2. Thought events (OpenCode's reasoning) appear in the Thenvoi room as the agent works.
3. The final reply is posted back as a normal chat message.

If OpenCode prompts for approval (with `OPENCODE_APPROVAL_MODE=manual`), the request shows up in the Thenvoi room as a permission request — respond there to continue or set `OPENCODE_APPROVAL_MODE=auto_accept` if you want it to proceed without asking.

## Common errors

| Error | Cause |
|-------|-------|
| `connect ECONNREFUSED 127.0.0.1:4096` | OpenCode server isn't running on that host/port |
| Agent connects but never replies | The OpenCode server is up but the configured `provider_id` / `model_id` doesn't exist; check `opencode serve` logs |
| Approval request hangs forever | `approvalMode` is `manual` and nobody answered. Set `auto_accept` if you want unattended runs. |
