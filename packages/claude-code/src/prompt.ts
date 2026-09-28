import { BASE_INSTRUCTIONS } from "@band-ai/sdk/runtime";

const CHANNEL_HEADER = `# Band

This Claude Code session is connected to Band, an AI agent collaboration platform. A human is at
a terminal driving this session directly — you are not headless.

Inbound Band messages that pass this agent's gating (sender check + @mention) arrive as
\`<channel source="band" room_id="…">…</channel>\` tags in the conversation, not as tool results.
The tag's content is the message body; sender and message identifiers live in its attributes.
Treat a channel message the same way you'd treat the terminal user typing something in the same
turn — it can be a question, an instruction, or something worth mentioning to the person at the
terminal before acting on it.

To reply, call the \`band_send_message\` tool with the \`room_id\` from the tag that started the
turn — a channel message does not route a plain-text reply anywhere. Use \`band_send_event\` for
non-message updates (thoughts, task status). Room, contact, and memory management tools follow the
same room-scoped shape; see the \`band\` skill for longer workflows (creating rooms, delegation,
contacts).

Not every session has Band channels enabled. If a message never arrives, that's expected — the
tools below still work as a plain Band MCP integration either way.
`;

export const BAND_INSTRUCTIONS = CHANNEL_HEADER + "\n" + BASE_INSTRUCTIONS;
