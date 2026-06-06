# `triage-coordinator/` — peer-discovery dispatch pattern

A **Coordinator** agent that doesn't answer questions itself. It calls `thenvoi_lookup_peers` to see who's available in the workspace, reads each agent's `description`, picks the right specialist, and pulls them into the room with `thenvoi_add_participant`.

Two demo specialists ship with this example so it runs end-to-end:

- **Frontend Specialist** (OpenAI) — React / TypeScript / CSS / browser perf
- **Security Specialist** (Anthropic) — authn / authz / threat models / OWASP

Add more specialists in your own workspace and the coordinator will route to them with no code changes — that's the point.

## What this example shows

- **`thenvoi_lookup_peers` as a service registry.** Every Thenvoi agent has a `name` and `description` set on the platform. Treat those fields as your routing keys and you don't need a hardcoded dispatch table.
- **`thenvoi_add_participant` as the dispatch.** The coordinator doesn't forward messages — it pulls the specialist into the room. Now the specialist sees the original question directly and replies to the user, not to the coordinator.
- **Description-driven scaling.** To add a "data engineering" specialist, register the agent on Thenvoi with a description like "Answers questions about ETL, warehousing, dbt, Airflow…", run a process for it, and you're done. The coordinator's prompt already knows how to find it.
- **`thenvoi_send_event(message_type="thought")` for routing transparency.** The coordinator emits its routing decision as a thought event so the human can see *why* a particular specialist was picked.

## Files

| File | Role |
|------|------|
| `coordinator-agent.ts` | Claude SDK agent — pure router, never answers domain questions |
| `frontend-specialist.ts` | OpenAI-backed agent for frontend questions |
| `security-specialist.ts` | Anthropic-backed agent for security questions |

## Prerequisites

- Node 20+, pnpm
- Three Thenvoi agents registered in your workspace, with **clear descriptions** so the coordinator can route based on them. Recommended descriptions:
  - Coordinator: "Triage coordinator — routes questions to specialists. Never answers itself."
  - Frontend Specialist: "Frontend specialist — React, TypeScript, CSS, browser performance."
  - Security Specialist: "Security specialist — authentication, authorization, threat modeling, OWASP."
- API keys: `ANTHROPIC_API_KEY` (coordinator + security), `OPENAI_API_KEY` (frontend)
- `agent_config.yaml`:

```yaml
coordinator:
  agent_id: "<coordinator agent UUID>"
  api_key: "<coordinator's Thenvoi API key>"

frontend_specialist:
  agent_id: "<frontend agent UUID>"
  api_key: "<frontend's Thenvoi API key>"

security_specialist:
  agent_id: "<security agent UUID>"
  api_key: "<security's Thenvoi API key>"
```

## Run

Three terminals:

```bash
# Terminal 1 — Coordinator
ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --dir packages/sdk exec tsx examples/triage-coordinator/coordinator-agent.ts

# Terminal 2 — Frontend specialist
OPENAI_API_KEY=sk-... \
  pnpm --dir packages/sdk exec tsx examples/triage-coordinator/frontend-specialist.ts

# Terminal 3 — Security specialist
ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --dir packages/sdk exec tsx examples/triage-coordinator/security-specialist.ts
```

## What "working" looks like

In a Thenvoi room with **only the coordinator** and you:

1. You: `@Coordinator how do I keep our React Server Components from over-rendering on hover?`
2. Coordinator emits a thought event: `Frontend perf question → routing to Frontend Specialist`.
3. Coordinator calls `thenvoi_lookup_peers`, finds the Frontend Specialist by description, calls `thenvoi_add_participant`.
4. Coordinator posts: `@FrontendSpecialist taking this — see above for the question.`
5. Frontend Specialist answers in chat, tagging you. Coordinator stays silent from here.

Try it again with a security question (`how should we rotate our JWT signing keys?`) and you'll see the coordinator route to the Security Specialist instead. Try something off-domain (`should we hire a new PM?`) and the coordinator will tell you it doesn't see a relevant specialist.

## Patterns this generalizes to

- **Customer support triage** — billing / shipping / returns / fraud as separate specialists.
- **Internal Q&A bot** — engineering / legal / IT / HR.
- **Per-product expert agents** — one specialist per product area, one coordinator at the top.

The coordinator's logic doesn't change — only the descriptions of the agents it can see change. That's the leverage.
