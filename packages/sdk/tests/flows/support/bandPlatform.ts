/**
 * The Band side of a flow test, run for real: `PlatformRuntime` → `BandLink` →
 * room `Execution` → `AgentTools` → REST, with only the network replaced.
 * Room traffic is posted the way the platform would, and everything the agent
 * posts lands in a transcript that refuses what the platform refuses.
 */
import { randomUUID } from "node:crypto";

import type { FrameworkAdapter } from "../../../src/contracts/protocols";
import type { ParticipantRecord } from "../../../src/contracts/dtos";
import type { PaginatedResponse, PlatformChatMessage, RestApi } from "../../../src/client/rest/types";
import { BandLink } from "../../../src/platform/BandLink";
import { PlatformRuntime } from "../../../src/runtime/PlatformRuntime";
import { CallHolds, FakeRestApi, FakeTransport, TrafficLog, type HeldCall } from "../../testUtils";

export const AGENT_ID = "agent-1";

export interface Posted {
  readonly roomId: string;
  readonly content: string;
  /** Mentioned participant ids; events carry none. */
  readonly mentions: readonly string[];
  readonly messageType: string;
  readonly metadata?: Record<string, unknown>;
}

export type Outcome = "processed" | "failed";

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
  public readonly posted: Posted[] = [];
  private readonly history: HistoryEntry[] = [];
  public readonly outcomes = new Map<string, Outcome>();
  public readonly traffic = new TrafficLog();
  public readonly messageHolds = new CallHolds<[roomId: string, content: string]>();

  public constructor(private readonly participants: readonly ParticipantRecord[]) {
    super({}, { id: AGENT_ID, name: "Agent", description: "Flow test agent" });
  }

  public override async createChatMessage(roomId: string, message: MessageBody) {
    // The platform never delivers a chat message that mentions nobody.
    if (!message.mentions?.length) {
      throw new Error("At least one mention is required");
    }
    await this.messageHolds.pass(roomId, message.content);
    this.record({ roomId, content: message.content, mentions: message.mentions.map((mention) => mention.id), messageType: "text" });
    return { id: `posted-${this.posted.length}` };
  }

  public override async createChatEvent(roomId: string, event: EventBody) {
    this.record({ roomId, content: event.content, mentions: [], messageType: event.messageType, metadata: event.metadata });
    return { id: `posted-${this.posted.length}` };
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

  public override async markMessageProcessed(_roomId: string, messageId: string) {
    return this.settle(messageId, "processed");
  }

  public override async markMessageFailed(_roomId: string, messageId: string) {
    return this.settle(messageId, "failed");
  }

  private settle(messageId: string, outcome: Outcome) {
    this.outcomes.set(messageId, outcome);
    this.traffic.record();
    return {};
  }

  private record(posted: Posted): void {
    this.posted.push(posted);
    this.remember(posted.roomId, {
      id: `posted-${this.posted.length}`, content: posted.content, sender_id: AGENT_ID, sender_type: "Agent", sender_name: "Agent",
      message_type: posted.messageType, metadata: posted.metadata ?? {}, inserted_at: now(), updated_at: now(),
    });
    this.traffic.record();
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
    return this.platform.rest.posted.filter((posted) => posted.roomId === this.id);
  }

  public get messages(): Posted[] {
    return this.posted.filter((posted) => posted.messageType === "text");
  }

  public events(messageType: string): Posted[] {
    return this.posted.filter((posted) => posted.messageType === messageType);
  }

  /** Resolves once the agent has posted a message here that `matches`, and returns it. */
  public async nextMessage(matches: (posted: Posted) => boolean, after = 0): Promise<Posted> {
    const found = () => this.messages.slice(after).find(matches);
    await this.until(() => found() !== undefined);
    return found()!;
  }

  /** Resolves with how the runtime settled `messageId`. */
  public async outcome(messageId: string): Promise<Outcome> {
    await this.until(() => this.platform.rest.outcomes.has(messageId));
    return this.platform.rest.outcomes.get(messageId)!;
  }

  /** Keeps the agent's next matching chat message in flight; with `error`, the platform then refuses it. */
  public holdMessage(matches: (content: string) => boolean, options: { error?: Error } = {}): HeldCall<[roomId: string, content: string]> {
    return this.platform.rest.messageHolds.hold((roomId, content) => roomId === this.id && matches(content), options);
  }

  public until(predicate: () => boolean): Promise<void> {
    return this.platform.rest.traffic.until(predicate);
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

  private constructor(participants: readonly ParticipantRecord[], rest?: RecordingRestApi) {
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

  public async room(roomId: string): Promise<BandRoom> {
    await this.transport.emit(`agent_rooms:${AGENT_ID}`, "room_added", roomPayload(roomId, "active"));
    return new BandRoom(roomId, this);
  }

  public async post(roomId: string, senderId: string, content: string): Promise<string> {
    const id = `msg-${randomUUID()}`;
    const message = { id, content, message_type: "text", sender_id: senderId, sender_type: "User", sender_name: senderId, inserted_at: now(), updated_at: now() };
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
