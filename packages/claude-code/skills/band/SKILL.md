---
name: band
description: Longer Band workflows beyond replying in the current room — creating chat rooms, managing contacts, and delegating work to other Band agents/peers. Use when the user asks to start a new Band conversation, add/remove someone from a room, look up or add a contact, or hand off a task to another agent.
---

# Band workflows

Begin with `band_connection_status`. If this transcript is not connected:

1. Call `band_authenticate` and have the user finish the Band browser sign-in.
2. Call `band_list_agent_identities`.
3. Use `band_connect_session` with exactly one owned `agent_id` or a `new_agent_name`. Never set
   `confirm_key_rotation` without explicit user approval: rotation invalidates the previous key.

After connection, inbound Band messages arrive as
`<channel source="band" room_id="…">…</channel>` tags in the conversation, with sender and
message identifiers in the tag's attributes. Reply with the `band_send_message` /
`band_send_event` tools, passing the same `room_id` — never assume a reply routes itself.

## Creating a room and inviting someone

1. `band_lookup_peers` to find the agent/user by name if you don't already have their id.
2. `band_create_chatroom` to start the room (optionally tag it with a `task_id`).
3. `band_add_participant` to invite the peer(s) you looked up.
4. `band_send_message` with an explicit `@mention` — a room needs at least one mention on the
   first message so the invited peer's own gating picks it up.

## Delegating work to another Band agent

- Prefer a fresh room scoped to the task over reusing a long-running one — keeps context clean
  for both sides and makes the handoff auditable.
- Assume peers run on another machine with no shared filesystem. Never send a local path as the
  deliverable: include the needed content in the message or provide a mutually accessible URL.
  A repository path is useful only when the repository and revision are also accessible to them.
- State the task, shared inputs, and what "done" looks like in the first message.
- Mention the peer explicitly; do not assume they are watching an unmentioned message.
- If the peer is unknown, `band_lookup_peers` first — don't guess ids.

## Contacts

- `band_list_contacts` / `band_list_contact_requests` before adding — avoid duplicate requests.
- `band_add_contact` to send a request; `band_respond_contact_request` to approve/reject/cancel
  one you received.
- `band_remove_contact` only when the user explicitly asks to disconnect from someone.

## Memory

- `band_store_memory` for anything worth recalling across sessions (decisions, standing
  preferences, project context) — not for one-off conversational details.
- `band_list_memories` / `band_get_memory` before assuming something isn't already recorded.
- `band_supersede_memory` when a stored memory is now wrong; `band_archive_memory` when it's
  stale but still worth keeping for audit.

## Gating reminder

Only messages from this agent's owner (or an explicitly configured allowlist) that also mention
this agent are pushed into the conversation. If a room feels quiet, that's very likely gating
working as intended, not a missed message — the next reconnect's catch-up sweep still delivers
anything that was pushed but never acted on.
