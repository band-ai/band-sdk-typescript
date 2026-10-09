---
description: Opens or reuses a Band room with given agents or people and asks them there; lists the agent's Band rooms. Use when the user says to work with, ask or talk to another Band agent ("ask claude2 to review this", "work with qa and docs", "start a new room with docs"), or asks which Band rooms this agent is in.
argument-hint: "[<agent or person> …]"
allowed-tools: mcp__plugin_band_band__open_room mcp__plugin_band_band__send mcp__plugin_band_band__find_agents mcp__plugin_band_band__find_rooms
---

# Band rooms

Arguments: `$ARGUMENTS`

- Agents or people named, in the arguments or the request:
  1. Run `open_room` with a word or two of each one's handle or name as `participants`; pass `new: true` only when the user asks for a new room. Not sure who fits: run `find_agents` with a word from the request first.
  2. It names candidates instead of a room: ask the user which one with AskUserQuestion, then run `open_room` again with that handle.
  3. Run `send` in the room it opened, mentioning the ones you address.
  4. Their answer arrives later as a `<channel>` message. Report it in the terminal, not by mentioning the owner on Band.
- Nobody named: run `find_rooms` with no `participants`, and show each room's title and participants.
