---
description: Shows which Band agent this Claude Code session is connected as and which agents other sessions hold; saves another Band agent by its ID and API key; picks the agent this project connects as; removes a saved agent. Use when the user asks which Band agent this is, wants this project or session to connect as a different Band agent, wants to add or remove a Band agent, or Band refused the session with connection_conflict.
argument-hint: "[add <agent_id> <api_key> [name] | use <name> | remove <name>]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/agents.js *)
model: sonnet
---

# Band agents

Each Claude Code session connects to Band as one agent, and Band lets one session at a time hold an agent. Status right now:

!`node ${CLAUDE_PLUGIN_ROOT}/dist/agents.js --data-dir "${CLAUDE_PLUGIN_DATA}" --project-dir "${CLAUDE_PROJECT_DIR}" status "${CLAUDE_SESSION_ID}"`

Arguments: `$ARGUMENTS`

- No arguments: reply with only the status above, verbatim in a code block, and stop. Don't summarize it or suggest anything it doesn't say.
- Otherwise, run the command below with the arguments in place of `<command>`, and show its output exactly as it is. A request in plain words maps to one command:
  - "connect this project as my docs agent", "switch to docs" → `use docs`
  - "add a Band agent" with an agent ID and API key → `add <agent_id> <api_key>`, plus a name if the user gave one, and `--ws-url <url>` only if the user gave a Band WebSocket URL
  - "forget the docs agent" → `remove docs`
  - "which Band agent is this?" → no command: answer from the status above

```
node ${CLAUDE_PLUGIN_ROOT}/dist/agents.js --data-dir "${CLAUDE_PLUGIN_DATA}" --project-dir "${CLAUDE_PROJECT_DIR}" <command>
```

The agent ID and API key come from the agent's page on Band. Never repeat an API key back to the user. A new agent selection applies to Claude Code sessions started after it, not to this one.
