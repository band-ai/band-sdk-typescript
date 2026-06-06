# Parlant examples

Five numbered scenarios showing how to drive Parlant-managed agents from Thenvoi via the `ParlantAdapter`, plus the original simple wrapper. Each scenario is a single `.ts` file that imports from the published `@thenvoi/sdk` package and a small shared `setup.ts` (also in this folder) — copy-paste any one of them into a new project and adjust the credentials.

## Scenarios

| File | Description |
|------|-------------|
| `parlant-agent.ts` | Plain wrapper: takes an existing `PARLANT_AGENT_ID`, no provisioning |
| `01-basic-agent.ts` | Provisions a Parlant agent with the full Thenvoi-aware tool guidelines (send message, lookup peers, add/remove participants, get participants, create rooms) |
| `02-with-guidelines.ts` | Wider conversation-flow + error-handling + goodbye guidelines |
| `03-support-agent.ts` | Customer support persona with empathy / urgency / escalation rules |
| `04-tom-agent.ts` | Tom the cat — character agent that pursues Jerry |
| `05-jerry-agent.ts` | Jerry the mouse — counterpart to Tom |

## Provisioning model

The `parlant-client` JS package is HTTP-only — there is no embedded Parlant server in JavaScript. Each scenario:

1. Connects to a Parlant server you're already running (`PARLANT_ENVIRONMENT`)
2. Calls `client.agents.create({...})` to provision a fresh agent with the scenario's description
3. Calls `client.guidelines.create({...})` for each guideline, tagged with the new agent's ID
4. Hands the resulting agent ID to `ParlantAdapter`

If your Parlant server's guideline-to-agent association uses something other than tags, edit `provisionParlantAgent` in `setup.ts` (it's the only place this wiring lives).

## Prerequisites

- A running Parlant server reachable at `PARLANT_ENVIRONMENT` (e.g. `http://localhost:8800`).
- `pnpm add parlant-client` — loaded dynamically so the SDK doesn't require it for users on other adapters.
- Thenvoi credentials in `agent_config.yaml` for the scenario you're running:
  - `parlant-agent.ts` / 01 / 02 → `parlant_agent`
  - 03 → `support_agent`
  - 04 → `tom_agent`
  - 05 → `jerry_agent`
- Optional: `PARLANT_API_KEY` if your Parlant server enforces an API key.

## Running

```bash
PARLANT_ENVIRONMENT=http://localhost:8800 \
  pnpm --dir packages/sdk exec tsx examples/parlant/01-basic-agent.ts
# …same shape for 02–05.
```

Each numbered script fails fast with a clear error if `PARLANT_ENVIRONMENT` or Thenvoi credentials are missing.

## Verify

In a Thenvoi room with the agent and a human user, send a message that exercises one of the configured guidelines. For example, on 03 (`03-support-agent.ts`), say "I'd like a refund" — the agent should respond with empathy and ask for an order number before answering. On 04, ask Tom to "catch Jerry"; on 05 (run alongside 04), Jerry should respond from his hole.
