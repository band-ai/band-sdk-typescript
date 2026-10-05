import type { BandLink } from "@band-ai/sdk";
import { errorResult, successResult, type McpToolRegistration } from "@band-ai/sdk/mcp";
import type { ChatParticipant } from "@band-ai/sdk/rest";
import { ensureHandlePrefix } from "@band-ai/sdk/runtime";

export const FIND_ROOMS_TOOL_NAME = "band_find_rooms";

type RoomLink = Pick<BandLink, "listAllChats" | "rest">;

export interface FoundRoom {
  readonly room_id: string;
  readonly title: string | null;
  readonly participants: ReadonlyArray<Pick<ChatParticipant, "name" | "handle" | "type">>;
}

interface ListedRoom {
  readonly room: FoundRoom;
  readonly updatedAt: number;
}

/** Finds the rooms the agent shares with given agents or people, the best fit first. */
export function findRoomsTool(link: RoomLink): McpToolRegistration {
  return {
    name: FIND_ROOMS_TOOL_NAME,
    description:
      "Find the Band rooms this agent is in that include every given agent or person, by name or handle; " +
      "with no participants, list all of its rooms. The best fit comes first: fewest participants, then most recently active.",
    inputSchema: {
      type: "object",
      properties: {
        participants: {
          type: "array",
          items: { type: "string" },
          description: "Names or handles that must all be in the room.",
        },
      },
      required: [],
    },
    execute: async ({ participants }) => {
      try {
        const wanted = (Array.isArray(participants) ? participants : []).map((entry) => normalize(String(entry))).filter((entry) => entry !== null);
        return successResult(await findRooms(link, wanted));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** The rooms holding everyone `wanted`, fewest participants first, then the most recently updated. */
async function findRooms(link: RoomLink, wanted: readonly string[]): Promise<FoundRoom[]> {
  return (await listRooms(link))
    .filter(({ room }) => wanted.every((entry) => room.participants.some((participant) => matchesEntry(participant, entry))))
    .sort((a, b) => a.room.participants.length - b.room.participants.length || b.updatedAt - a.updatedAt)
    .map(({ room }) => room);
}

async function listRooms(link: RoomLink): Promise<ListedRoom[]> {
  const chats = await link.listAllChats();
  return Promise.all(chats.map(async (chat) => {
    const roomId = String(chat.id);
    const participants = await link.rest.listChatParticipants(roomId);
    return {
      room: {
        room_id: roomId,
        title: typeof chat.title === "string" ? chat.title : null,
        participants: participants.map(({ name, handle, type }) => ({ name, handle: handle ?? null, type })),
      },
      updatedAt: Date.parse(String(chat.updated_at)),
    };
  }));
}

function matchesEntry({ name, handle }: Pick<ChatParticipant, "name" | "handle">, entry: string): boolean {
  return normalize(name) === entry || normalize(handle) === entry;
}

/** Names and handles compare case-insensitively, with or without the handle's `@`. */
function normalize(value: string | null | undefined): string | null {
  return ensureHandlePrefix(value?.trim().toLowerCase());
}
