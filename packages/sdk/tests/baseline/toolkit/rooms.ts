/**
 * Room CRUD, acting as the platform user: the user creates the room, adds the
 * agents under test, and mentions them — as a person would. From creation, a
 * user-authenticated observer records every message frame in the room —
 * replies and delivery-state updates alike — so a wait never misses a frame
 * that landed before it started. Released when its `await using` scope or its
 * test ends; release never throws.
 */
import { DEFAULT_WS_URL } from "../../../src/platform/BandLink";
import type { MessageCreatedPayload } from "../../../src/platform/events";
import { roomTopics } from "../../../src/platform/roomTopics";
import { PhoenixChannelsTransport } from "../../../src/platform/streaming/PhoenixChannelsTransport";
import { deleteRoomsBulk } from "../../integration/support/liveHarness";
import { RecordLog } from "../../testUtils";
import type { AgentIdentity } from "./agents";
import { debugLogger } from "./debugLogger";
import { liveRun, releasedWithTest, warnTeardown } from "./liveRun";

/** Leading characters of a room id that label its observer's logs, enough to tell rooms apart. */
const ROOM_LABEL_ID_LENGTH = 8;

/** A message the scenario posted, by id — what delivery waits key on. */
export interface SentMessage {
  id: string;
}

export class Room implements AsyncDisposable {
  /** Every `message_created` frame, in arrival order. */
  public readonly messages = new RecordLog<MessageCreatedPayload>();
  /** Every `message_updated` frame (per-recipient delivery state), in arrival order. */
  public readonly deliveryUpdates = new RecordLog<MessageCreatedPayload>();
  /** The last message the scenario posted — what a reply answers. */
  public lastSent: SentMessage | null = null;

  private constructor(
    public readonly id: string,
    private readonly observer: PhoenixChannelsTransport,
  ) {}

  public static async create(): Promise<Room> {
    const { env } = await liveRun();
    const created = await env.userClient.humanApiChats.createMyChatRoom({ chat: {} });
    const room = releasedWithTest(
      new Room(
        created.data.id,
        new PhoenixChannelsTransport({
          wsUrl: env.wsUrl ?? DEFAULT_WS_URL,
          apiKey: env.userApiKey,
          logger: debugLogger(`observer ${created.data.id.slice(0, ROOM_LABEL_ID_LENGTH)}`),
        }),
      ),
    );
    try {
      await room.observe();
    } catch (error) {
      await room[Symbol.asyncDispose]();
      throw error;
    }
    return room;
  }

  private async observe(): Promise<void> {
    await this.observer.connect();
    await this.observer.join(roomTopics(this.id).chat, {
      message_created: (payload) => this.messages.record(payload as MessageCreatedPayload),
      message_updated: (payload) => this.deliveryUpdates.record(payload as MessageCreatedPayload),
    });
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.observer.disconnect().catch(warnTeardown(`disconnect observer of room ${this.id}`));
    const { env } = await liveRun();
    await deleteRoomsBulk(env.restUrl, env.userApiKey, [this.id]).catch(warnTeardown(`delete room ${this.id}`));
  }
}

async function addParticipant(room: Room, participant: AgentIdentity): Promise<void> {
  const { env } = await liveRun();
  await env.userClient.humanApiParticipants.addMyChatParticipant(room.id, {
    participant: { participant_id: participant.id },
  });
}

async function removeParticipant(room: Room, participant: AgentIdentity): Promise<void> {
  const { env } = await liveRun();
  await env.userClient.humanApiParticipants.removeMyChatParticipant(room.id, participant.id);
}

/** The ids of everyone in the room. */
async function participantIds(room: Room): Promise<string[]> {
  const { env } = await liveRun();
  const { data } = await env.userClient.humanApiParticipants.listMyChatParticipants(room.id);
  return data.map((participant) => participant.id);
}

/**
 * Posts `text` @mentioning `recipient` so it is delivered to them — as the
 * user, or as the agent `from` for agent-to-agent traffic.
 */
async function sendMention(
  room: Room,
  recipient: AgentIdentity,
  text: string,
  { from }: { from?: AgentIdentity } = {},
): Promise<SentMessage> {
  const content = `@${recipient.name} ${text}`;
  const id = from ? await sendAsAgent(from, room, recipient, content) : await sendAsUser(room, recipient, content);
  room.lastSent = { id };
  return room.lastSent;
}

async function sendAsUser(room: Room, recipient: AgentIdentity, content: string): Promise<string> {
  const { env } = await liveRun();
  const sent = await env.userClient.humanApiMessages.sendMyChatMessage(room.id, {
    message: { content, mentions: [{ id: recipient.id, name: recipient.name }] },
  });
  return sent.data.id;
}

async function sendAsAgent(from: AgentIdentity, room: Room, recipient: AgentIdentity, content: string): Promise<string> {
  const sent = await from.rest.createChatMessage(room.id, { content, mentions: [{ id: recipient.id, handle: recipient.name }] });
  if (typeof sent.id !== "string") {
    throw new Error(`createChatMessage returned no message id for room ${room.id}`);
  }
  return sent.id;
}

export const Rooms = {
  create: Room.create,
  addParticipant,
  removeParticipant,
  participantIds,
  sendMention,
};
