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

## Running

From `packages/sdk/`:

```bash
pnpm exec tsx examples/anthropic/01_basic_agent.ts
pnpm exec tsx examples/anthropic/02_custom_instructions.ts
```

## Configuration

Copy `agent_config.yaml.example` to `agent_config.yaml` and fill in:

```yaml
anthropic_agent:
  agent_id: "your-anthropic-agent-id"
  api_key: "your-api-key"

support_agent:
  agent_id: "your-support-agent-id"
  api_key: "your-api-key"
```

- `01_basic_agent.ts` uses `loadAgentConfig("anthropic_agent")`
- `02_custom_instructions.ts` uses `loadAgentConfig("support_agent")`

Provider credentials come from the environment (`ANTHROPIC_API_KEY`), not from the YAML file.

## Architecture

`AnthropicAdapter` provides per-room conversation history, platform history hydration, participant updates, and the Band platform tool loop. Set `enableExecutionReporting: true` (as in `02`) to post tool activity into the room.
