# Coding agents (planner + reviewer)

A 2-agent team that collaborates in a single Thenvoi room over a shared workspace:

- **Planner** — `ClaudeSDKAdapter` running Claude. Owns `notes/plan.md`.
- **Reviewer** — `CodexAdapter` running an OpenAI Codex model. Owns `notes/review.md`.

The agents coordinate via short chat messages (`thenvoi_send_message` with `@mentions`) and exchange long-form content as files in a shared workspace. Point both processes at the same host directory and they'll collaborate over `notes/plan.md` and `notes/review.md`.

## Files

| File | Description |
|------|-------------|
| `planner-agent.ts` | Claude SDK planner |
| `reviewer-agent.ts` | Codex reviewer |
| `prompts/planner.md` | Planner system-prompt section (loaded at startup) |
| `prompts/reviewer.md` | Reviewer system-prompt section (loaded at startup) |

The prompts reference `/workspace/...` paths; both scripts rewrite that prefix to your actual workspace at load time.

## Workspace layout

The agents expect this layout under `WORKSPACE` (defaults to `./.coding-agents-workspace`):

```
<workspace>/
├── repo/      # Source code (read-only for both agents)
├── notes/     # plan.md, review.md, ad-hoc collaboration files
└── state/     # Anything you want persisted across restarts
```

Create the directories yourself (or clone a repo into `repo/`) before running the agents. Neither script will create or clone anything for you — that's by design so you don't accidentally point at the wrong directory.

```bash
export WORKSPACE="$PWD/.coding-agents-workspace"
mkdir -p "$WORKSPACE"/{repo,notes,state}
git clone https://github.com/your/project "$WORKSPACE/repo"
```

## Prerequisites

- `ANTHROPIC_API_KEY` — for the planner (Claude SDK)
- `OPENAI_API_KEY` — for the reviewer (Codex)
- Two Thenvoi agents in the same workspace, registered ahead of time
- An `agent_config.yaml` in the working directory with both keys:

```yaml
planner:
  agent_id: "<planner agent UUID>"
  api_key: "<planner agent's Thenvoi API key>"

reviewer:
  agent_id: "<reviewer agent UUID>"
  api_key: "<reviewer agent's Thenvoi API key>"
```

Override the reviewer's yaml key with `REVIEWER_AGENT_KEY=other_key` if you're running multiple reviewers.

Optional reviewer tuning:

| Variable | Default | Description |
|----------|---------|-------------|
| `REVIEWER_MODEL` | `gpt-5.5-codex` | OpenAI Codex model |
| `REVIEWER_REASONING_EFFORT` | `high` | One of `minimal`, `low`, `medium`, `high`, `xhigh` |
| `REVIEWER_AGENT_KEY` | `reviewer` | `agent_config.yaml` key to load |

## Running

Two terminals, one agent each:

```bash
# Terminal 1 — Planner
WORKSPACE="$PWD/.coding-agents-workspace" \
  pnpm --dir packages/sdk exec tsx examples/coding-agents/planner-agent.ts

# Terminal 2 — Reviewer
WORKSPACE="$PWD/.coding-agents-workspace" \
  pnpm --dir packages/sdk exec tsx examples/coding-agents/reviewer-agent.ts
```

Each agent will connect to Thenvoi, subscribe to existing rooms, and idle until a human asks the planner to plan something.

## Verify

In a Thenvoi room with both agents and a human user:

1. As the user, message the planner: `@Planner please plan adding rate limiting to the auth endpoints`
2. The planner writes `notes/plan.md` and `@`-mentions the reviewer once with a one-line summary
3. The reviewer reads `notes/plan.md`, writes `notes/review.md`, and replies in chat with either `Approved.` (mentions the human) or `Changes requested — see review.md` (mentions the planner)
4. Iteration continues until the plan is approved

If you don't see file activity, check that both processes have the same `WORKSPACE` and that the directory exists.

## Notes

- No Docker. Run directly with `tsx`. Bring your own workspace directory.
- No automatic repo cloning or context indexing. Pre-populate `repo/` yourself.
- No host-key checking, no SSH credential mounts. The processes inherit your shell environment.
