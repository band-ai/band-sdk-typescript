# `debate-agents/` — Claude advocate vs Codex skeptic

Two agents debate a proposal you post in a Thenvoi room. The **Advocate** (Claude) argues for. The **Skeptic** (Codex) argues against. They take turns by mentioning each other; after ~3 turns per side, whichever spoke last posts a written **Verdict** mentioning you.

Use this when you want a structured "steelman both sides" sanity check before committing to a decision — refactor calls, architectural choices, hiring shortlists, anything where seeing both arguments side by side helps you think.

## What this example shows

- **The room as the protocol.** No shared filesystem, no orchestrator, no message queue. Each agent is a normal Thenvoi participant; turn-taking emerges from mentions because the platform delivers a message to an agent only when it's @-mentioned (or when the room owner sends a non-tagged message).
- **Different models on different SDKs.** Advocate runs on `ClaudeSDKAdapter`, Skeptic on `CodexAdapter`. The platform doesn't care.
- **`thenvoi_send_event(message_type="thought")`** as in-character thinking that the room renders separately from chat — useful for showing the agents' reasoning without polluting the debate transcript.
- **Asymmetric roles via system prompts only.** No code differences in turn logic; the persona text owns the difference.

## Files

| File | Role |
|------|------|
| `advocate-agent.ts` | Claude SDK agent that argues for the proposal |
| `skeptic-agent.ts` | Codex agent that argues against |

## Prerequisites

- Node 20+, pnpm
- Two Thenvoi agents registered in your workspace (the advocate and the skeptic)
- `ANTHROPIC_API_KEY` (advocate) and `OPENAI_API_KEY` (skeptic)
- `agent_config.yaml`:

```yaml
advocate:
  agent_id: "<advocate agent UUID>"
  api_key: "<advocate's Thenvoi API key>"

skeptic:
  agent_id: "<skeptic agent UUID>"
  api_key: "<skeptic's Thenvoi API key>"
```

Optional skeptic tunables:

```bash
export SKEPTIC_MODEL=gpt-5.3-codex
export SKEPTIC_REASONING_EFFORT=high   # minimal | low | medium | high | xhigh
```

## Run

Two terminals, one agent each:

```bash
# Terminal 1 — Advocate (Claude)
ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --dir packages/sdk exec tsx examples/debate-agents/advocate-agent.ts

# Terminal 2 — Skeptic (Codex)
OPENAI_API_KEY=sk-... \
  pnpm --dir packages/sdk exec tsx examples/debate-agents/skeptic-agent.ts
```

Both agents connect to Thenvoi and idle until they're invited to a room.

## What "working" looks like

In a Thenvoi room with both agents and you:

1. You post a proposal: `@Advocate @Skeptic — should we move our analytics pipeline from Airflow to Dagster?`
2. The Advocate replies with arguments for, tagging the Skeptic.
3. The Skeptic rebuts, tagging the Advocate.
4. After ~3 turns each, one side posts a **Verdict:** message tagging you with a one-line summary and an `accept | accept with caveats | reject` call.

You can interject at any point — both prompts respect human messages and adjust their next turn. To kill the loop early, just message either agent without tagging the other.

## Why this is a useful pattern

- The same shape works for any "two roles in dialogue" agent setup: red/blue team, optimist/pessimist, customer/CSM rehearsal, lawyer/opposing-counsel review.
- The agents don't need to know about each other at code-time — they discover each other through `thenvoi_get_participants` at runtime. Add a third "moderator" agent (or a fourth, fifth) and the same protocol scales without code changes.
