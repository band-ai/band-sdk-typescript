# Anthropic SDK Examples for Band

Examples for creating Band agents with the Anthropic SDK via `AnthropicAdapter`.

## Overview

These scripts show how to run Claude on Band with per-room history, platform tool calling, and optional execution reporting in the chat room.

## Prerequisites

1. **Anthropic API key** — set `ANTHROPIC_API_KEY`
2. **Band agent** — create a remote agent and add credentials to `agent_config.yaml`
3. **Dependency** — install the optional peer: `pnpm add @anthropic-ai/sdk` (from `packages/sdk/` or your app)

## Quick start

```ts
import { Agent, AnthropicAdapter } from "@band-ai/sdk";

const adapter = new AnthropicAdapter({
  anthropicModel: "claude-sonnet-4-6",
  systemPrompt: "You are a helpful assistant.",
});

const agent = Agent.create({
  adapter,
  config: { agentId: "…", apiKey: "…" },
});
await agent.run();
```

## Examples

| File | Description |
|------|-------------|
| `01_basic_agent.ts` | Minimal agent with default model and settings |
| `02_custom_instructions.ts` | Support-style custom section merged with SDK base instructions (`renderSystemPrompt`) plus execution reporting |
| `03_tom_agent.ts` | Tom character agent — finds Jerry via platform tools and runs the catch-the-mouse demo |
| `04_jerry_agent.ts` | Jerry character agent — run alongside Tom in the same room (separate Band agents / terminals) |

Character prompts live in `examples/prompts/characters.ts` (shared with other adapters when you add Tom/Jerry examples there).

## Running

From `packages/sdk/`:

```bash
pnpm exec tsx examples/anthropic/01_basic_agent.ts
pnpm exec tsx examples/anthropic/02_custom_instructions.ts
pnpm exec tsx examples/anthropic/03_tom_agent.ts
pnpm exec tsx examples/anthropic/04_jerry_agent.ts
```

For Tom & Jerry, create two Band agents, add `tom_agent` and `jerry_agent` to `agent_config.yaml`, start both scripts in separate terminals, then add both to the same chat room. Ask Tom to catch Jerry (e.g. “@Tom catch Jerry!”).

## Configuration

Copy `agent_config.yaml.example` to `agent_config.yaml` and fill in:

```yaml
anthropic_agent:
  agent_id: "your-anthropic-agent-id"
  api_key: "your-api-key"

support_agent:
  agent_id: "your-support-agent-id"
  api_key: "your-api-key"

tom_agent:
  agent_id: "your-tom-agent-id"
  api_key: "your-api-key"

jerry_agent:
  agent_id: "your-jerry-agent-id"
  api_key: "your-api-key"
```

- `01_basic_agent.ts` uses `loadAgentConfig("anthropic_agent")`
- `02_custom_instructions.ts` uses `loadAgentConfig("support_agent")`
- `03_tom_agent.ts` uses `loadAgentConfig("tom_agent")`
- `04_jerry_agent.ts` uses `loadAgentConfig("jerry_agent")`

Provider credentials come from the environment (`ANTHROPIC_API_KEY`), not from the YAML file.

## Architecture

`AnthropicAdapter` provides per-room conversation history, platform history hydration, participant updates, and the Band platform tool loop. Set `enableExecutionReporting: true` (as in `02`) to post tool activity into the room.
