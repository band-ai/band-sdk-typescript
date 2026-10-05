/**
 * The Band side of a flow test, run for real: `PlatformRuntime` → `BandLink` →
 * room `Execution` → `AgentTools` → REST, with only the network replaced.
 * Room traffic is posted the way the platform would, and everything the agent
 * posts lands in a transcript that refuses what the platform refuses.
 */
import { randomUUID } from "node:crypto";

import { agentRoomsTopic, chatRoomTopic } from "@band-ai/band-sdk-core";

import type { FrameworkAdapter } from "../../../src/contracts/protocols";
import type { ParticipantRecord } from "../../../src/contracts/dtos";
import type { PaginatedResponse, PlatformChatMessage, RestApi } from "../../../src/client/rest/types";
import { BandLink } from "../../../src/platform/BandLink";
import { PlatformRuntime } from "../../../src/runtime/PlatformRuntime";
import { assertMentioned, CallHolds, FakeRestApi, FakeTransport, RecordLog, reportedFailures, wireMention, type HeldCall, type ReportedFailure } from "../../testUtils";

export const AGENT_ID = "agent-1";
export const AGENT_API_KEY = "flow-test-key";
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

/** How a posted message looks on the wire; a plain user text message by default. */
export interface PostOptions {
  readonly senderType?: "User" | "Agent";
  readonly messageType?: string;
  /** The display name the platform sends; the sender id by default. */
  readonly senderName?: string | null;
}

/** The agent's identity as `getAgentMe` reports it. */
export interface AgentIdentityOptions {
  readonly ownerUuid?: string | null;
}

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

/**
 * The platform's REST surface as the agent sees it: it records every post, keeps each room's history,
 * lists the agent's rooms, serves the backlog left before the agent connected, and settles each message's outcome.
 */
export class RecordingRestApi extends FakeRestApi {
  public readonly posted = new RecordLog<Posted>();
  public readonly settled = new RecordLog<Settled>();
  /** Ids of messages the runtime has started handing to the agent. */
  public readonly processing = new RecordLog<string>();
  private readonly history: HistoryEntry[] = [];
  private readonly backlog: HistoryEntry[] = [];
  private readonly rooms = new Set<string>();
  public readonly messageHolds = new CallHolds<[roomId: string, content: string]>();
  public readonly processingHolds = new CallHolds<[messageId: string]>();
  public readonly nextMessageHolds = new CallHolds<[roomId: string]>();

  public constructor(private readonly participants: readonly ParticipantRecord[], identity: AgentIdentityOptions = {}) {
    super({}, { id: AGENT_ID, name: "Agent", description: "Flow test agent", ...identity });
  }

  /** Every room on one page. */
  public override async listChats(): Promise<PaginatedResponse> {
    return { data: [...this.rooms].map((roomId) => roomPayload(roomId, "active")), metadata: { page: 1, totalPages: 1 } };
  }

  /** The oldest backlog message in the room not yet settled, as `/messages/next` serves it. */
  public override async getNextMessage(request: { chatId: string }): Promise<PlatformChatMessage | null> {
    const pending = this.backlog.find((entry) => entry.roomId === request.chatId && !this.isSettled(entry.item.id));
    await this.nextMessageHolds.pass(request.chatId);
    return pending?.item ?? null;
  }

  public addRoom(roomId: string): void {
    this.rooms.add(roomId);
  }

  public removeRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  /** Adds a message to the backlog an agent that is not connected yet finds once it connects. */
  public addBacklog(roomId: string, item: PlatformChatMessage): void {
    this.remember(roomId, item);
    this.backlog.push({ roomId, item });
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
    await this.processingHolds.pass(messageId);
    return {};
  }

  public override async markMessageProcessed(_roomId: string, messageId: string) {
    return this.settle(messageId, "processed");
  }

  public override async markMessageFailed(_roomId: string, messageId: string) {
    return this.settle(messageId, "failed");
  }

  private isSettled(messageId: string): boolean {
    return this.settled.entries.some((settled) => settled.messageId === messageId);
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
  public async say(senderId: string, content: string, options?: PostOptions): Promise<string> {
    return this.platform.post(this.id, senderId, content, options);
  }

  /** Posts `content` from `senderId` for the agent to find once it connects; returns its message id. */
  public postBeforeConnect(senderId: string, content: string, options?: PostOptions): string {
    return this.platform.postBeforeConnect(this.id, senderId, content, options);
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
    return reportedFailures(this.posted);
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

  /** Keeps the runtime's processing mark for `messageId` in flight until released. */
  public holdProcessing(messageId: string): HeldCall<[messageId: string]> {
    return this.platform.rest.processingHolds.hold((id) => id === messageId);
  }

  public until(predicate: () => boolean): Promise<void> {
    return this.platform.rest.posted.until(predicate);
  }

  /** Keeps the agent's join of this room in flight until the returned function releases it. */
  public holdJoin(): () => void {
    return this.platform.transport.gateJoin(chatRoomTopic(this.id));
  }

  /** Resolves once the agent has begun leaving the room: it unsubscribes before tearing the room down. */
  public async left(): Promise<void> {
    await this.platform.transport.left.next((topic) => topic === chatRoomTopic(this.id));
  }

  /** The platform removes the agent from the room. */
  public async remove(): Promise<void> {
    this.platform.rest.removeRoom(this.id);
    await this.platform.transport.emit(agentRoomsTopic(AGENT_ID), "room_removed", roomPayload(this.id, "inactive"));
  }
}

/** One agent on a platform whose rooms hold `participants`. */
export class BandPlatform implements AsyncDisposable {
  public readonly transport = new FakeTransport();
  public readonly rest: RecordingRestApi;
  /** What a runtime connects to this platform through. */
  public readonly link: { readonly transport: FakeTransport; readonly restApi: RecordingRestApi };
  private runtime?: PlatformRuntime;
  private readonly mentionable: readonly ParticipantRecord[];

  private constructor(participants: readonly ParticipantRecord[], rest?: RecordingRestApi) {
    this.mentionable = [...participants, AGENT_PARTICIPANT];
    this.rest = rest ?? new RecordingRestApi(participants);
    this.link = { transport: this.transport, restApi: this.rest };
  }

  /** The platform alone, for a host that builds its own runtime on `transport` and `rest`. */
  public static host(participants: readonly ParticipantRecord[], identity?: AgentIdentityOptions): BandPlatform {
    return new BandPlatform(participants, new RecordingRestApi(participants, identity));
  }

  /** Starts the agent; pass an earlier platform's `rest` to restart it against the same rooms and history. */
  public static async start(adapter: FrameworkAdapter, participants: readonly ParticipantRecord[], rest?: RecordingRestApi): Promise<BandPlatform> {
    const platform = new BandPlatform(participants, rest);
    platform.runtime = new PlatformRuntime({
      agentId: AGENT_ID,
      apiKey: AGENT_API_KEY,
      link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    });
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

  /** Adds the agent to a room: a connected agent hears it, one not yet connected finds it in its room list. */
  public async room(roomId: string): Promise<BandRoom> {
    this.rest.addRoom(roomId);
    const topic = agentRoomsTopic(AGENT_ID);
    if (this.transport.hasTopic(topic)) {
      await this.transport.emit(topic, "room_added", roomPayload(roomId, "active"));
    }
    return new BandRoom(roomId, this);
  }

  /** Delivers a message live, once the agent is subscribed to the room. */
  public async post(roomId: string, senderId: string, content: string, options?: PostOptions): Promise<string> {
    const message = this.message(senderId, content, options);
    this.rest.remember(roomId, message);
    const topic = chatRoomTopic(roomId);
    await this.transport.bound.until(() => this.transport.hasTopic(topic));
    await this.transport.emit(topic, "message_created", message);
    return message.id;
  }

  public postBeforeConnect(roomId: string, senderId: string, content: string, options?: PostOptions): string {
    const message = this.message(senderId, content, options);
    this.rest.addBacklog(roomId, message);
    return message.id;
  }

  private message(senderId: string, content: string, options: PostOptions = {}) {
    const mentions = this.mentionable
      .filter((participant) => content.includes(`@[[${participant.id}]]`))
      .map(({ id, name, type, handle }) => wireMention({ id, name, handle: handle ?? null, type: type.toLowerCase() }));
    return {
      id: `msg-${randomUUID()}`, content, message_type: options.messageType ?? "text", sender_id: senderId,
      sender_type: options.senderType ?? "User", sender_name: options.senderName === undefined ? senderId : options.senderName, metadata: { mentions }, inserted_at: now(), updated_at: now(),
    };
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.runtime?.stop();
  }
}

export function person(id: string): ParticipantRecord {
  return { id, name: id, type: "User", handle: id };
}

export function agent(id: string): ParticipantRecord {
  return { id, name: id, type: "Agent", handle: id };
}
