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
