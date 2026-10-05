---
description: Picks the Band agent this project's Claude Code sessions connect as, offering the saved agents and adding a new one by its ID and API key; shows which agent this session and the others hold; removes a saved agent. Use when the user wants to set up Band, asks which Band agent this is, wants this project or session to connect as a different Band agent, wants to add or remove a Band agent, or Band refused the session.
argument-hint: "[add <agent_id> <api_key> [name] | use <name> | remove <name>]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/agents.js *)
model: sonnet
---

# Band agents

Each Claude Code session connects to Band as one saved agent, and Band lets one session at a time hold an agent. Status right now:

!`node ${CLAUDE_PLUGIN_ROOT}/dist/agents.js --data-dir "${CLAUDE_PLUGIN_DATA}" --project-dir "${CLAUDE_PROJECT_DIR}" status "${CLAUDE_SESSION_ID}"`

Arguments: `$ARGUMENTS`

Run commands as below, with the command in place of `<command>`, and show their output exactly as it is:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/agents.js --data-dir "${CLAUDE_PLUGIN_DATA}" --project-dir "${CLAUDE_PROJECT_DIR}" --ws-url '${user_config.ws_url}' <command>
```

- No arguments:
  1. With no agent saved, show the status above verbatim in a code block, then follow step 3.
  2. Otherwise ask with AskUserQuestion which agent this project should connect as. Put this session's state from the status's first line in the question, for example "This session is refused: int1676-alpha is in use in ~/repo/web. Which Band agent should this project connect as?". Offer up to three saved agents, free ones first, each labeled with its name and described with its handle and whether it is free, in use and where, or this session's; and last, "Add a new agent". A saved agent picked: run `use <name>`.
  3. "Add a new agent": ask in plain text for the agent ID and API key from the agent's page on Band, run `add <agent_id> <api_key>`, and when it succeeds run `use <name it was saved as>`.
- Arguments given: run them as the command. A request in plain words maps to one command:
  - "connect this project as my docs agent", "switch to docs" → `use docs`
  - "add a Band agent" with an agent ID and API key → `add <agent_id> <api_key>`, plus a name if the user gave one
  - "forget the docs agent" → `remove docs`
  - "which Band agent is this?" → no command: answer from the status above

Never repeat an API key back to the user.
