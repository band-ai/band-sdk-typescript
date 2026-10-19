# Claude Agent SDK Examples for Band

Connect the Claude Code CLI (Agent SDK) to Band through `ClaudeSDKAdapter`.

## Prerequisites

1. **Node.js 22+**
2. **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code` (verify with `claude --version`)
3. **`ANTHROPIC_API_KEY`** in the environment
4. **Band agent** — `claude_sdk_agent` or shared `tom_agent` / `jerry_agent` in `agent_config.yaml`

## Examples

| File | Description |
|------|-------------|
| `01_basic_agent.ts` | Default model, MCP Band tools, `acceptEdits` permission mode |
| `02_tom_agent.ts` | Tom character (`customSection` merged with Band base instructions) |
| `03_jerry_agent.ts` | Jerry character — pair with Tom in one room |

## Running

From `packages/sdk/`:

```bash
pnpm exec tsx examples/claude-sdk/01_basic_agent.ts
pnpm exec tsx examples/claude-sdk/02_tom_agent.ts
pnpm exec tsx examples/claude-sdk/03_jerry_agent.ts
```

## Configuration

```yaml
claude_sdk_agent:
  agent_id: "your-claude-sdk-agent-id"
  api_key: "your-api-key"

tom_agent:
  agent_id: "your-tom-agent-id"
  api_key: "your-api-key"

jerry_agent:
  agent_id: "your-jerry-agent-id"
  api_key: "your-api-key"
```

### Automatic working indicator

Working state is on by default through shared runtime
[`sessionConfig`](../../../../README.md#automatic-working-state), with a three-second
keep-alive and two-second request budget. Use `Agent.create({ ..., sessionConfig:
{ enableWorkingState: false } })` to disable it. No provider-specific option or
tool capability is needed. Execution reporting options control chat tool narration
independently of this automatic indicator and its activity detail.

```ts
import { Agent, ClaudeSDKAdapter, loadAgentConfig } from "@band-ai/sdk";

const agent = Agent.create({
  config: loadAgentConfig("my_agent"),
  sessionConfig: { enableWorkingState: true },
  adapter: new ClaudeSDKAdapter({ enableExecutionReporting: false }),
});
```

Ask for an allowed native Bash operation, such as `pwd`. Existing permission policy
still applies. Native start/end hooks report `tool_call/Bash` then reasoning on a
compatible agent API, with no command in activity or tool narration in chat.
The main thread's compaction status reports memory. This adapter does not expose an interactive
approval resolver, so SDK policy checks alone do not establish a human wait.
