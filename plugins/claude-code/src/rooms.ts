import type { McpToolRegistration } from "@band-ai/sdk/mcp";
import { listAllPeers, type ChatParticipant } from "@band-ai/sdk/rest";

import { handleOf, normalizeHandle, resolveAll, type Candidate } from "./names";
import { bandErrorText, bandStatus, requiredString, stringList, TOOL, toolResult, type ToolContext } from "./tools";

/** Band's answer for a room the agent isn't in, as when it left after the room was listed. */
const NOT_A_MEMBER_STATUS = 404;
/** Band refuses an invite of someone the agent can't reach, and a rename by anyone but the owner. */
const FORBIDDEN_STATUS = 403;
/** Band's answer for an invite of someone already in the room. */
const ALREADY_PARTICIPANT_STATUS = 409;
const MEMBER_ROLE = "member";

const REACHABLE = "Reachable";
const NOT_REACHABLE = "not reachable, usually no approved contact: approve it on Band";
const UNTITLED = "untitled; Band names it after the first message";
const ADDED = "added";
const ALREADY_IN_ROOM = "already in room";

type RoomLink = ToolContext["link"];

export interface FoundRoom {
  readonly room_id: string;
  readonly title: string | null;
  /** Everyone in the room besides this agent. */
  readonly participants: ReadonlyArray<Pick<ChatParticipant, "name" | "handle" | "type">>;
}

interface ListedRoom {
  readonly room: FoundRoom;
  readonly participantIds: readonly string[];
  readonly updatedAt: number;
}

/** Finds the rooms the agent shares with given agents or people, the best fit first. */
export function findRoomsTool(context: ToolContext): McpToolRegistration {
  return {
    name: TOOL.findRooms,
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
    execute: (args) => toolResult(TOOL.findRooms, context, async () =>
      JSON.stringify(await findRooms(context.link, stringList(args.participants).map(normalizeHandle)))),
  };
}

export function openRoomTool(context: ToolContext): McpToolRegistration {
  // Calls for one set of participants share one find-or-create, so at most one room is created.
  const inFlight = new Map<string, Promise<string>>();
  return {
    name: TOOL.openRoom,
    description:
      "Opens a Band room with the given agents or people, to work with them: reuses the most recently active room whose participants, " +
      "besides this agent, are exactly them, or creates one and invites them. Name each by a word or two of their handle, name or description " +
      `(\`qa\` for "the qa bot"). Pass new: true only when the user asks for a new room. Then post there with ${TOOL.send}(room_id).`,
    inputSchema: {
      type: "object",
      properties: {
        participants: { type: "array", items: { type: "string" }, description: "Everyone the room is with, by handle, name or a word of their description." },
        title: { type: "string", description: "The title of a room it creates; reused rooms keep theirs." },
        new: { type: "boolean", description: "Create a new room even if one with them exists." },
      },
      required: ["participants"],
    },
    execute: (args) => toolResult(TOOL.openRoom, context, async () => {
      const entries = stringList(args.participants);
      if (entries.length === 0) {
        throw new Error("Name at least one participant.");
      }
      const wanted = uniqueById(resolveAll(entries, await reachable(context), REACHABLE));
      const title = typeof args.title === "string" && args.title.trim() ? args.title : undefined;
      if (args.new === true) {
        return createRoom(context, wanted, title);
      }
      const key = wanted.map(({ id }) => id).sort().join(",");
      const shared = inFlight.get(key) ?? findOrCreate(context, wanted, title).finally(() => inFlight.delete(key));
      inFlight.set(key, shared);
      return shared;
    }),
  };
}

export function inviteTool(context: ToolContext): McpToolRegistration {
  return {
    name: TOOL.invite,
    description:
      "Invites agents or people into a Band room this agent is in, each by a word or two of their handle, name or description. " +
      `Reports each as added, already in room, or failed with Band's reason. Use it after ${TOOL.openRoom} left someone out, or to bring someone in.`,
    inputSchema: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "The room to invite them into." },
        participants: { type: "array", items: { type: "string" }, description: "Who to invite, by handle, name or a word of their description." },
      },
      required: ["room_id", "participants"],
    },
    execute: (args) => toolResult(TOOL.invite, context, async () => {
      const roomId = requiredString(args, "room_id");
      const wanted = uniqueById(resolveAll(stringList(args.participants), await reachable(context), REACHABLE));
      const inRoom = new Set((await context.link.rest.listChatParticipants(roomId)).map(({ id }) => id));
      const lines = await Promise.all(wanted.map(async (candidate) => {
        if (inRoom.has(candidate.id)) {
          return `${handleOf(candidate)}: ${ALREADY_IN_ROOM}`;
        }
        const outcome = await addToRoom(context, roomId, candidate);
        return `${handleOf(candidate)}: ${typeof outcome === "string" ? outcome : `failed: ${outcome.failed}`}`;
      }));
      return lines.join("\n");
    }),
  };
}

export function renameRoomTool(context: ToolContext): McpToolRegistration {
  return {
    name: TOOL.renameRoom,
    description: "Renames a Band room. Only the room's owner can, so it works in rooms this agent created.",
    inputSchema: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "The room to rename." },
        title: { type: "string", description: "The new title." },
      },
      required: ["room_id", "title"],
    },
    execute: (args) => toolResult(TOOL.renameRoom, context, async () => {
      const { rest } = context.link;
      if (!rest.renameChat) {
        throw new Error("Band's REST client can't rename a room");
      }
      const roomId = requiredString(args, "room_id");
      const title = requiredString(args, "title");
      try {
        const room = await rest.renameChat(roomId, title);
        return `Renamed to '${room.title ?? title}'.`;
      } catch (error) {
        throw bandStatus(error) === FORBIDDEN_STATUS ? new Error("Only the room's owner can rename it.") : error;
      }
    }),
  };
}

/** The rooms holding everyone `wanted`, fewest participants first, then the most recently updated; a blank entry matches no one. */
async function findRooms(link: RoomLink, wanted: readonly string[]): Promise<FoundRoom[]> {
  return (await listRooms(link))
    .filter(({ room }) => wanted.every((entry) => entry !== "" && room.participants.some((participant) => matchesEntry(participant, entry))))
    .sort((a, b) => a.room.participants.length - b.room.participants.length || b.updatedAt - a.updatedAt)
    .map(({ room }) => room);
}

/** The most recently active room whose participants besides this agent are exactly `wanted`, or a new one with them. */
async function findOrCreate(context: ToolContext, wanted: readonly Candidate[], title: string | undefined): Promise<string> {
  const ids = new Set(wanted.map(({ id }) => id));
  const [best] = (await listRooms(context.link))
    .filter(({ participantIds }) => participantIds.length === ids.size && participantIds.every((id) => ids.has(id)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return best ? `Reused '${best.room.title ?? UNTITLED}' (room_id ${best.room.room_id}).` : createRoom(context, wanted, title);
}

async function createRoom(context: ToolContext, wanted: readonly Candidate[], title: string | undefined): Promise<string> {
  const { id } = await context.link.rest.createChat({ title });
  const outcomes = await Promise.all(wanted.map((candidate) => addToRoom(context, id, candidate)));
  const lines = wanted.map((candidate, index) => {
    const outcome = outcomes[index];
    return `${handleOf(candidate)}: ${typeof outcome === "string" ? "invited" : `not invited: ${outcome.failed}`}`;
  });
  const nobody = outcomes.every((outcome) => typeof outcome !== "string")
    ? [`Nobody was invited: retry with ${TOOL.invite}(room_id), or approve the contact on Band.`]
    : [];
  return [`Created '${title ?? UNTITLED}' (room_id ${id}).`, ...lines, ...nobody].join("\n");
}

type AddOutcome = typeof ADDED | typeof ALREADY_IN_ROOM | { readonly failed: string };

/** Adds one participant by id (Band's invite takes nothing else), and says how it went. */
async function addToRoom({ link }: ToolContext, roomId: string, { id }: Candidate): Promise<AddOutcome> {
  try {
    await link.rest.addChatParticipant(roomId, { participantId: id, role: MEMBER_ROLE });
    return ADDED;
  } catch (error) {
    const status = bandStatus(error);
    if (status === ALREADY_PARTICIPANT_STATUS) {
      return ALREADY_IN_ROOM;
    }
    return { failed: status === FORBIDDEN_STATUS ? NOT_REACHABLE : bandErrorText(error) };
  }
}

/** Everyone Band lets this agent reach: its owner, its contacts and the agents it may use. */
async function reachable({ link, self }: ToolContext): Promise<Candidate[]> {
  return (await listAllPeers(link.rest)).flatMap(({ id, name, type, handle, description }) =>
    id && id !== self.id ? [{ id, name: name ?? id, type: type ?? "", handle, description }] : []);
}

function uniqueById(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter(({ id }, index) => candidates.findIndex((other) => other.id === id) === index);
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
      participantIds: participants.map(({ id }) => id),
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
    if (bandStatus(error) === NOT_A_MEMBER_STATUS) {
      return null;
    }
    throw error;
  }
}

function matchesEntry({ name, handle }: Pick<ChatParticipant, "name" | "handle">, entry: string): boolean {
  return normalizeHandle(name) === entry || normalizeHandle(handle) === entry;
}
