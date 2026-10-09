import type { McpToolRegistration } from "@band-ai/sdk/mcp";
import { listAllPeers } from "@band-ai/sdk/rest";

import { AGENT_TYPE, handleOf, matchesWords } from "./names";
import { TOOL, toolResult, type ToolContext } from "./tools";

/** Lists the agents this one can reach, optionally only those matching a query, marking who is in a room. */
export function findAgentsTool(context: ToolContext): McpToolRegistration {
  return {
    name: TOOL.findAgents,
    description:
      "Lists the Band agents this agent can reach, one per line: handle, name and description. With query, only agents with every word " +
      `in their handle, name or description; with room_id, marks those already in that room. Use it to see who can help, then ${TOOL.openRoom} with their handles.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words that must all appear in an agent's handle, name or description." },
        room_id: { type: "string", description: "A room whose participants are marked (in room)." },
      },
      required: [],
    },
    execute: (args) => toolResult(TOOL.findAgents, context, async () => {
      const { rest } = context.link;
      const query = typeof args.query === "string" && args.query.trim() ? args.query : undefined;
      const roomId = typeof args.room_id === "string" && args.room_id ? args.room_id : undefined;
      const [peers, inRoom] = await Promise.all([
        listAllPeers(rest),
        roomId ? rest.listChatParticipants(roomId).then((participants) => new Set(participants.map(({ id }) => id))) : new Set<string>(),
      ]);
      const agents = peers.flatMap(({ id, name, type, handle, description }) =>
        id && type === AGENT_TYPE ? [{ id, name: name ?? id, type, handle, description }] : [])
        .filter((agent) => query === undefined || matchesWords(agent, query));
      if (agents.length === 0) {
        return query ? `No reachable agent matches "${query}".` : "No agents are reachable.";
      }
      return agents
        .map((agent) => [handleOf(agent), agent.name, agent.description].filter(Boolean).join(" — ") + (inRoom.has(agent.id) ? " (in room)" : ""))
        .join("\n");
    }),
  };
}
