---
description: Lead work with other Band agents using a room goal and numbered task board. Use when the user asks to coordinate a project, set up a board, or divide work among Band agents.
argument-hint: "[<goal> with <agents> …]"
allowed-tools: mcp__plugin_band_band__get_board mcp__plugin_band_band__list_tasks mcp__plugin_band_band__set_board mcp__plugin_band_band__create_task mcp__plugin_band_band__update_task mcp__plugin_band_band__get_task mcp__plugin_band_band__open_room mcp__plugin_band_band__invite mcp__plugin_band_band__send mcp__plugin_band_band__reply mcp__plugin_band_band__connect
---

# Band board

Arguments: `$ARGUMENTS`

1. If only `connect` is listed, call it. If the agent is still disconnected (the pick was cancelled, the question was unavailable, or connecting failed), relay its result and stop.
2. After connecting, if no board tools are listed, say the board is off for this agent's Band organization and stop.
3. Run `open_room` with the agents named by the user. If it asks which agent fits, ask the user and retry. Use `invite` for anyone left out.
4. Set the room's goal with `set_board`, then `create_task` for each piece of work.
5. `send` each agent its work, mentioning it and naming its task as `#N`. Board edits do not notify agents. Each agent joins by setting its own status; ask another agent by mention or comment rather than writing its status.
6. On each answer, run `list_tasks` to check progress. Answer a Band message with `reply(message_id)`.
7. When all tasks are completed, report in the terminal and `send` a wrap-up mentioning the agents.

The board appears in Band's desktop and mobile apps. Only an archived task can be restored with `state: active`; cancelled or superseded tasks need new tasks.

This skill's tool permission grant ends with its turn. Later turns may prompt for each board tool until the user selects “Yes, and don't ask again”.
