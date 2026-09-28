/**
 * Room CRUD, acting as the platform user: the user creates the room, adds the
 * agents under test, and mentions them — as a person would. From creation, a
 * user-authenticated observer records every message frame in the room —
 * replies and delivery-state updates alike — so a wait never misses a frame
 * that landed before it started. Released when its `await using` scope ends;
 * release never throws.
 */
import { DEFAULT_WS_URL } from "../../../src/platform/BandLink";
import type { MessageCreatedPayload } from "../../../src/platform/events";
import { roomTopics } from "../../../src/platform/roomTopics";
import { PhoenixChannelsTransport } from "../../../src/platform/streaming/PhoenixChannelsTransport";
import { deleteRoomsBulk } from "../../integration/support/liveHarness";
import { RecordLog } from "../../testUtils";
import type { AgentIdentity } from "./agents";
import { liveRun, warnTeardown } from "./liveRun";

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
    const room = new Room(
      created.data.id,
      new PhoenixChannelsTransport({ wsUrl: env.wsUrl ?? DEFAULT_WS_URL, apiKey: env.userApiKey }),
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

/** Posts `text` as the user, @mentioning `recipient` so it is delivered to them. */
async function sendMention(room: Room, recipient: AgentIdentity, text: string): Promise<SentMessage> {
  const { env } = await liveRun();
  const sent = await env.userClient.humanApiMessages.sendMyChatMessage(room.id, {
    message: { content: `@${recipient.name} ${text}`, mentions: [{ id: recipient.id, name: recipient.name }] },
  });
  room.lastSent = { id: sent.data.id };
  return room.lastSent;
}

export const Rooms = {
  create: Room.create,
  addParticipant,
  sendMention,
};
