import type { McpToolRegistration } from "@band-ai/sdk/mcp";
import { listAllPeers } from "@band-ai/sdk/rest";

import { AGENT_TYPE, handleOf, matchesWords, type Candidate } from "./names";
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
        context.refreshAgents ? context.refreshAgents() : reachable(context),
        roomId ? rest.listChatParticipants(roomId).then((participants) => new Set(participants.map(({ id }) => id))) : new Set<string>(),
      ]);
      const agents = peers.filter((peer) => peer.type === AGENT_TYPE && (query === undefined || matchesWords(peer, query)));
      if (agents.length === 0) {
        return query ? `No reachable agent matches "${query}".` : "No agents are reachable.";
      }
      return agents
        .map((agent) => [handleOf(agent), agent.handle ? agent.name : null, agent.description].filter(Boolean).join(" — ") + (inRoom.has(agent.id) ? " (in room)" : ""))
        .join("\n");
    }),
  };
}

/** Everyone Band lets this agent reach: its owner, its contacts and the agents it may use. */
export async function reachable({ link, self }: Pick<ToolContext, "link" | "self">): Promise<Candidate[]> {
  return (await listAllPeers(link.rest)).flatMap(({ id, name, type, handle, description }) =>
    id && id !== self.id ? [{ id, name: name ?? id, type: type ?? "", handle, description }] : []);
}
