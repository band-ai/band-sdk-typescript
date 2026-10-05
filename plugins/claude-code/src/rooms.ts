import type { BandLink } from "@band-ai/sdk";
import type { Logger } from "@band-ai/sdk/core";
import { errorResult, successResult, type McpToolRegistration } from "@band-ai/sdk/mcp";
import type { ChatParticipant } from "@band-ai/sdk/rest";
import { ensureHandlePrefix } from "@band-ai/sdk/runtime";

export const FIND_ROOMS_TOOL_NAME = "band_find_rooms";

/** Band's answer for a room the agent isn't in, as when it left after the room was listed. */
const NOT_A_MEMBER_STATUS = 404;

type RoomLink = Pick<BandLink, "agentId" | "listAllChats" | "rest">;

export interface FoundRoom {
  readonly room_id: string;
  readonly title: string | null;
  /** Everyone in the room besides this agent. */
  readonly participants: ReadonlyArray<Pick<ChatParticipant, "name" | "handle" | "type">>;
}

interface ListedRoom {
  readonly room: FoundRoom;
  readonly updatedAt: number;
}

/** Finds the rooms the agent shares with given agents or people, the best fit first. */
export function findRoomsTool(link: RoomLink, logger: Logger): McpToolRegistration {
  return {
    name: FIND_ROOMS_TOOL_NAME,
    description:
      "Find the Band rooms this agent is in that include every given agent or person, by name or handle; " +
      "with no participants, list all of its rooms. Each room lists its participants besides this agent. " +
      "The best fit comes first: fewest participants, then most recently active.",
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
        const wanted = (Array.isArray(participants) ? participants : []).map((entry) => normalize(String(entry)));
        return successResult(await findRooms(link, wanted));
      } catch (error) {
        logger.error("band_find_rooms failed", { error });
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** The rooms holding everyone `wanted`, fewest participants first, then the most recently updated; a blank entry matches no one. */
async function findRooms(link: RoomLink, wanted: ReadonlyArray<string | null>): Promise<FoundRoom[]> {
  return (await listRooms(link))
    .filter(({ room }) => wanted.every((entry) => entry !== null && room.participants.some((participant) => matchesEntry(participant, entry))))
    .sort((a, b) => a.room.participants.length - b.room.participants.length || b.updatedAt - a.updatedAt)
    .map(({ room }) => room);
}

async function listRooms(link: RoomLink): Promise<ListedRoom[]> {
  const chats = await link.listAllChats();
  const listed = await Promise.all(chats.map(async (chat): Promise<ListedRoom | null> => {
    const roomId = String(chat.id);
    const participants = await othersIn(link, roomId);
    return participants && {
      room: {
        room_id: roomId,
        title: typeof chat.title === "string" ? chat.title : null,
        participants: participants.map(({ name, handle, type }) => ({ name, handle: handle ?? null, type })),
      },
      updatedAt: Date.parse(String(chat.updated_at)),
    };
  }));
  return listed.filter((room) => room !== null);
}

/** Everyone in the room besides this agent; none when the agent left it after it was listed. */
async function othersIn(link: RoomLink, roomId: string): Promise<ChatParticipant[] | null> {
  try {
    return (await link.rest.listChatParticipants(roomId)).filter(({ id }) => id !== link.agentId);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === NOT_A_MEMBER_STATUS) {
      return null;
    }
    throw error;
  }
}

function matchesEntry({ name, handle }: Pick<ChatParticipant, "name" | "handle">, entry: string): boolean {
  return normalize(name) === entry || normalize(handle) === entry;
}

/** Names and handles compare case-insensitively, with or without the handle's `@`. */
function normalize(value: string | null | undefined): string | null {
  return ensureHandlePrefix(value?.trim().toLowerCase());
}
