/**
 * The Band side of a flow test, run for real: `PlatformRuntime` → `BandLink` →
 * room `Execution` → `AgentTools` → REST, with only the network replaced.
 * Room traffic is posted the way the platform would, and everything the agent
 * posts lands in a transcript that refuses what the platform refuses.
 */
import { randomUUID } from "node:crypto";

import { missingReplyMessage } from "@band-ai/band-sdk-core";

import { FAILURE_EVENT_TYPE, FAILURE_METADATA_KEY, type FrameworkAdapter } from "../../../src/contracts/protocols";
import type { ParticipantRecord } from "../../../src/contracts/dtos";
import type { PaginatedResponse, PlatformChatMessage, RestApi } from "../../../src/client/rest/types";
import { BandLink } from "../../../src/platform/BandLink";
import { TURN_FAILURE_PROVIDER } from "../../../src/core/turn";
import { PlatformRuntime } from "../../../src/runtime/PlatformRuntime";
import { assertMentioned, CallHolds, FakeRestApi, FakeTransport, RecordLog, wireMention, type HeldCall } from "../../testUtils";

export const AGENT_ID = "agent-1";
export const AGENT_HANDLE = "owner/agent";

// The agent is mentionable but never a room participant, so the participants
// message a flow sees stays what its roster says.
const AGENT_PARTICIPANT: ParticipantRecord = { id: AGENT_ID, name: "Agent", type: "Agent", handle: AGENT_HANDLE };

export interface Posted {
  readonly roomId: string;
  readonly content: string;
  /** Mentioned participant ids; events carry none. */
  readonly mentions: readonly string[];
  readonly messageType: string;
  readonly metadata?: Record<string, unknown>;
}

export type Outcome = "processed" | "failed";

/** A failure the agent reported in a room: what it says, and whom it blames. */
export interface ReportedFailure {
  readonly content: string;
  readonly provider: unknown;
}

/** The report of a turn that ended without a reply: band-sdk-core's text, blamed on the runtime's verdict. */
export const MISSING_REPLY: ReportedFailure = { content: missingReplyMessage(), provider: TURN_FAILURE_PROVIDER };

interface Settled {
  readonly messageId: string;
  readonly outcome: Outcome;
}

type MessageBody = Parameters<RestApi["createChatMessage"]>[1];
type EventBody = Parameters<RestApi["createChatEvent"]>[1];

const now = () => new Date().toISOString();

function roomPayload(roomId: string, status: "active" | "inactive") {
  return { id: roomId, status, type: "direct", title: roomId, task_id: null, inserted_at: now(), updated_at: now() };
}

interface HistoryEntry {
  readonly roomId: string;
  readonly item: PlatformChatMessage;
}

/** The platform's REST surface as the agent sees it: it records every post, keeps each room's history, and settles each message's outcome. */
export class RecordingRestApi extends FakeRestApi {
  public readonly posted = new RecordLog<Posted>();
  public readonly settled = new RecordLog<Settled>();
  /** Ids of messages the runtime has started handing to the agent. */
  public readonly processing = new RecordLog<string>();
  private readonly history: HistoryEntry[] = [];
  public readonly messageHolds = new CallHolds<[roomId: string, content: string]>();

  public constructor(private readonly participants: readonly ParticipantRecord[]) {
    super({}, { id: AGENT_ID, name: "Agent", description: "Flow test agent" });
  }

  public override async createChatMessage(roomId: string, message: MessageBody) {
    assertMentioned(message.mentions);
    await this.messageHolds.pass(roomId, message.content);
    this.record({ roomId, content: message.content, mentions: message.mentions.map((mention) => mention.id), messageType: "text" });
    return { id: `posted-${this.posted.entries.length}` };
  }

  public override async createChatEvent(roomId: string, event: EventBody) {
    this.record({ roomId, content: event.content, mentions: [], messageType: event.messageType, metadata: event.metadata });
    return { id: `posted-${this.posted.entries.length}` };
  }

  public override async listChatParticipants() {
    return [...this.participants];
  }

  /** The room's conversation as the platform hands it to a fresh session: what people said and what the agent posted. */
  public async getChatContext(request: { chatId: string }): Promise<PaginatedResponse<PlatformChatMessage>> {
    return { data: this.history.filter((entry) => entry.roomId === request.chatId).map((entry) => entry.item) };
  }

  public remember(roomId: string, item: PlatformChatMessage): void {
    this.history.push({ roomId, item });
  }

  public override async markMessageProcessing(_roomId: string, messageId: string) {
    this.processing.record(messageId);
    return {};
  }

  public override async markMessageProcessed(_roomId: string, messageId: string) {
    return this.settle(messageId, "processed");
  }

  public override async markMessageFailed(_roomId: string, messageId: string) {
    return this.settle(messageId, "failed");
  }

  private settle(messageId: string, outcome: Outcome) {
    this.settled.record({ messageId, outcome });
    return {};
  }

  private record(posted: Posted): void {
    this.posted.record(posted);
    this.remember(posted.roomId, {
      id: `posted-${this.posted.entries.length}`, content: posted.content, sender_id: AGENT_ID, sender_type: "Agent", sender_name: "Agent",
      message_type: posted.messageType, metadata: posted.metadata ?? {}, inserted_at: now(), updated_at: now(),
    });
  }
}

/** A room the agent was added to: people speak in it, and it shows what the agent posted back. */
export class BandRoom {
  public constructor(
    public readonly id: string,
    private readonly platform: BandPlatform,
  ) {}

  /** Posts `content` from `senderId`; resolves with its message id once the platform has queued it. */
  public async say(senderId: string, content: string): Promise<string> {
    return this.platform.post(this.id, senderId, content);
  }

  /** Posts `content` from `senderId`, waits for the runtime to settle it, and returns what the agent told that sender meanwhile. */
  public async exchange(senderId: string, content: string): Promise<string[]> {
    const after = this.messages.length;
    await this.outcome(await this.say(senderId, content));
    return this.messages.slice(after).filter((posted) => posted.mentions.includes(senderId)).map((posted) => posted.content);
  }

  /** Everything the agent posted here, messages and events, in order. */
  public get posted(): Posted[] {
    return this.platform.rest.posted.entries.filter((posted) => posted.roomId === this.id);
  }

  public get messages(): Posted[] {
    return this.posted.filter((posted) => posted.messageType === "text");
  }

  public events(messageType: string): Posted[] {
    return this.posted.filter((posted) => posted.messageType === messageType);
  }

  /** Every failure the agent reported here, in order; a plain error-typed notice carries no failure and is left out. */
  public get failures(): ReportedFailure[] {
    return this.events(FAILURE_EVENT_TYPE).flatMap((event) => {
      const failure = event.metadata?.[FAILURE_METADATA_KEY] as { provider?: unknown } | undefined;
      return failure ? [{ content: event.content, provider: failure.provider }] : [];
    });
  }

  /** Resolves once the agent has posted a message here that `matches`, and returns it. */
  public nextMessage(matches: (posted: Posted) => boolean): Promise<Posted> {
    return this.platform.rest.posted.next((posted) => posted.roomId === this.id && posted.messageType === "text" && matches(posted));
  }

  /** Resolves with how the runtime settled `messageId`. */
  public async outcome(messageId: string): Promise<Outcome> {
    return (await this.platform.rest.settled.next((settled) => settled.messageId === messageId)).outcome;
  }

  /** Every outcome the runtime has settled `messageId` with so far. */
  public outcomes(messageId: string): Outcome[] {
    return this.platform.rest.settled.entries.filter((settled) => settled.messageId === messageId).map((settled) => settled.outcome);
  }

  /** Resolves once the runtime starts handing `messageId` to the agent. */
  public async processing(messageId: string): Promise<void> {
    await this.platform.rest.processing.next((id) => id === messageId);
  }

  /** Keeps the agent's next matching chat message in flight; with `error`, the platform then refuses it. */
  public holdMessage(matches: (content: string) => boolean, options: { error?: Error } = {}): HeldCall<[roomId: string, content: string]> {
    return this.platform.rest.messageHolds.hold((roomId, content) => roomId === this.id && matches(content), options);
  }

  public until(predicate: () => boolean): Promise<void> {
    return this.platform.rest.posted.until(predicate);
  }

  /** The platform removes the agent from the room. */
  public async remove(): Promise<void> {
    await this.platform.transport.emit(`agent_rooms:${AGENT_ID}`, "room_removed", roomPayload(this.id, "inactive"));
  }
}

/** One agent on a platform whose rooms hold `participants`. */
export class BandPlatform implements AsyncDisposable {
  public readonly transport = new FakeTransport();
  public readonly rest: RecordingRestApi;
  private readonly runtime: PlatformRuntime;
  private readonly mentionable: readonly ParticipantRecord[];

  private constructor(participants: readonly ParticipantRecord[], rest?: RecordingRestApi) {
    this.mentionable = [...participants, AGENT_PARTICIPANT];
    this.rest = rest ?? new RecordingRestApi(participants);
    this.runtime = new PlatformRuntime({
      agentId: AGENT_ID,
      apiKey: "flow-test-key",
      link: new BandLink({ agentId: AGENT_ID, apiKey: "flow-test-key", transport: this.transport, restApi: this.rest }),
    });
  }

  /** Starts the agent; pass an earlier platform's `rest` to restart it against the same rooms and history. */
  public static async start(adapter: FrameworkAdapter, participants: readonly ParticipantRecord[], rest?: RecordingRestApi): Promise<BandPlatform> {
    const platform = new BandPlatform(participants, rest);
    await platform.runtime.start(adapter);
    return platform;
  }

  /** Starts the agent, as `start` does, and adds it to one room. */
  public static async join(
    adapter: FrameworkAdapter,
    participants: readonly ParticipantRecord[],
    options: { roomId?: string; rest?: RecordingRestApi } = {},
  ): Promise<{ platform: BandPlatform; room: BandRoom } & AsyncDisposable> {
    const platform = await BandPlatform.start(adapter, participants, options.rest);
    const room = await platform.room(options.roomId ?? "room-1");
    return { platform, room, [Symbol.asyncDispose]: () => platform[Symbol.asyncDispose]() };
  }

  public async room(roomId: string): Promise<BandRoom> {
    await this.transport.emit(`agent_rooms:${AGENT_ID}`, "room_added", roomPayload(roomId, "active"));
    return new BandRoom(roomId, this);
  }

  public async post(roomId: string, senderId: string, content: string): Promise<string> {
    const id = `msg-${randomUUID()}`;
    const mentions = this.mentionable
      .filter((participant) => content.includes(`@[[${participant.id}]]`))
      .map(({ id, name, type, handle }) => wireMention({ id, name, handle: handle ?? null, type: type.toLowerCase() }));
    const message = {
      id, content, message_type: "text", sender_id: senderId, sender_type: "User", sender_name: senderId,
      metadata: { mentions }, inserted_at: now(), updated_at: now(),
    };
    this.rest.remember(roomId, message);
    await this.transport.emit(`chat_room:${roomId}`, "message_created", message);
    return id;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.runtime.stop();
  }
}

export function person(id: string): ParticipantRecord {
  return { id, name: id, type: "User", handle: id };
}
