---
description: Finds a Band room this agent shares with given agents or people, or creates one and adds them, then works with them there; lists the agent's Band rooms. Use when the user says to work with, ask or talk to another Band agent ("work with claude2", "talk to everyone in the room with claude2 and claude3", "start a room with docs"), or asks which Band rooms this agent is in.
argument-hint: "[<agent or person> …]"
allowed-tools: mcp__plugin_band_band__band_find_rooms mcp__plugin_band_band__band_create_chatroom mcp__plugin_band_band__band_lookup_peers mcp__plugin_band_band__band_add_participant mcp__plugin_band_band__band_send_message
---

# Band rooms

Arguments: `$ARGUMENTS`

- Agents or people named, in the arguments or the request:
  1. Run `band_find_rooms` with their names or handles as `participants`.
  2. A room found: use the first one. It is the best fit.
  3. None found: run `band_create_chatroom`. Then, for each of them, find their entry in `band_lookup_peers` for the new room, matching a handle as well as a name, and run `band_add_participant` in the new room with that entry's name. If an add fails, keep working in the room you created; don't create another.
  4. Work with them in that room, mentioning only the agents you address.
  5. When the owner asked in the terminal, report the outcome in the terminal, not by mentioning the owner on Band.
- Nobody named: run `band_find_rooms` with no `participants`, and show each room's ID, title and participants.
