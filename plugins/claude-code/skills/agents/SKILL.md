---
description: Connects this Claude Code session to Band as a saved agent, adds a Band agent by its ID and API key, removes one, and says which Band agent this session is and what to do next.
when_to_use: When the user says "join Band", "connect to Band", "connect to agents", "set up Band", "add a Band agent" or "which Band agent is this?", or otherwise wants this session on Band, wants to add or remove a Band agent, or asks why Band is off.
argument-hint: "[add <agent_id> <api_key> [name] | remove <name> | status]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/agents.js *), mcp__plugin_band_band__connect
model: sonnet
---

# Band agents

Each Claude Code session started with Band's channel acts on Band as one saved agent, picked when the session starts or through the `connect` tool. Picking an agent another session holds moves it here. This session right now:

!`node ${CLAUDE_PLUGIN_ROOT}/dist/agents.js --data-dir "${CLAUDE_PLUGIN_DATA}" status "${CLAUDE_SESSION_ID}"`

Arguments: `$ARGUMENTS`

Run commands as below, with the command in place of `<command>`, and show their output exactly as it is:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/agents.js --data-dir "${CLAUDE_PLUGIN_DATA}" --ws-url '${user_config.ws_url}' <command>
```

- No arguments, or a request in plain words to join or set up Band:
  1. Say the status sentence above.
  2. If it says no agent is saved, ask in plain text for the agent ID and API key from the agent's page on Band, run `add <agent_id> <api_key>`, then go on to step 3.
  3. If the `connect` tool is available, call it: it shows the user the question that picks the agent. Otherwise give the sentence's next step, such as the restart command.
- `add <agent_id> <api_key> [name]`, or "add a Band agent" with an ID and key: run it, then call `connect` if it is available.
- `remove <name>`, or "forget the docs agent": first confirm with AskUserQuestion, then run `remove <name>`.
- `status`, or "which Band agent is this?": say the status sentence above; no command.

Never repeat an API key back to the user.
