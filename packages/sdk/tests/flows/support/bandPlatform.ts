/**
 * The Band side of a flow test, run for real: `PlatformRuntime` → `BandLink` →
 * room `Execution` → `AgentTools` → REST, with only the network replaced.
 * Room traffic is posted the way the platform would, and everything the agent
 * posts lands in a transcript that refuses what the platform refuses.
 */
import { randomUUID } from "node:crypto";

import { agentRoomsTopic, chatRoomTopic } from "@band-ai/band-sdk-core";
import { Band } from "@band-ai/rest-client";

import type { FrameworkAdapter } from "../../../src/contracts/protocols";
import type { ParticipantRecord, PeerRecord, WireBoard, WireTask, WireTaskPage } from "../../../src/contracts/dtos";
import { DEFAULT_PAGE_SIZE, type CursorPageRequest } from "../../../src/client/rest/pagination";
import type { ChatRoom, CreateChatRequest, PaginatedResponse, PlatformChatMessage, RestApi } from "../../../src/client/rest/types";
import { BandLink } from "../../../src/platform/BandLink";
import { PlatformRuntime } from "../../../src/runtime/PlatformRuntime";
import { assertMentioned, CallHolds, FakeRestApi, FakeTransport, RecordLog, reportedFailures, wireMention, type HeldCall, type ReportedFailure } from "../../testUtils";

export const AGENT_ID = "agent-1";
export const AGENT_API_KEY = "flow-test-key";
export const AGENT_HANDLE = "owner/agent";

/** Someone on the platform; Band sends `description` on agent rows, of peers and participants alike. */
export type PlatformParticipant = ParticipantRecord & { readonly description?: string | null };

// The agent is in every one of its rooms, as Band lists it among a room's participants.
const AGENT_PARTICIPANT: PlatformParticipant = { id: AGENT_ID, name: "Agent", type: "Agent", handle: AGENT_HANDLE };

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
  /** `AGENT_ID` by default; sessions may reconnect as a different identity. */
  readonly id?: string;
  readonly ownerUuid?: string | null;
  readonly featureFlags?: Readonly<Record<string, boolean>>;
  /** `AGENT_HANDLE` by default. */
  readonly handle?: string | null;
}

interface Settled {
  readonly messageId: string;
  readonly outcome: Outcome;
}

type MessageBody = Parameters<RestApi["createChatMessage"]>[1];
type EventBody = Parameters<RestApi["createChatEvent"]>[1];

const now = () => new Date().toISOString();
const FIRST_PAGE = 1;

function roomPayload(roomId: string, status: "active" | "inactive", updatedAt = now(), title = roomId) {
  return { id: roomId, status, type: "direct", title, task_id: null, inserted_at: updatedAt, updated_at: updatedAt };
}

/** A room call Band refused, because the agent isn't in the room. */
export interface Refused {
  readonly roomId: string;
  readonly call: keyof RestApi;
  /** What a refused message or event would have posted. */
  readonly attempt?: Posted;
}

/** What the agent added to a room. */
export interface Added {
  readonly roomId: string;
  readonly participantId: string;
}

export interface BoardCall {
  readonly roomId: string;
  readonly call: "getChatBoard" | "putChatBoard" | "listChatTasks" | "createChatTask" | "getChatTask" | "updateChatTask";
  readonly args: unknown;
  readonly id?: string;
}

const BOARD_ACTOR = { id: AGENT_ID, type: "Agent", name: "Agent", handle: AGENT_HANDLE } as const;

interface RoomState {
  board: WireBoard;
  tasks: WireTask[];
  participants: PlatformParticipant[];
  title?: string;
  /** Whether the agent created the room, which makes it the owner. */
  owned?: boolean;
  /** When anything was last said in the room, as Band's `updated_at` moves. */
  updatedAt: string;
}

interface HistoryEntry {
  readonly roomId: string;
  readonly item: PlatformChatMessage;
}

/**
 * The platform's REST surface as the agent sees it: it records every post, keeps each room's history
 * and participants, lists the agent's rooms, serves the backlog left before the agent connected, and
 * settles each message's outcome. Like Band, it refuses message, event and participant calls for a room the agent isn't in.
 */
export class RecordingRestApi extends FakeRestApi {
  public readonly peerCalls = new RecordLog<number>();
  public readonly peerHolds = new CallHolds<[page: number]>();
  public readonly boardCalls = new RecordLog<BoardCall>();
  public readonly posted = new RecordLog<Posted>();
  public readonly settled = new RecordLog<Settled>();
  public readonly added = new RecordLog<Added>();
  public readonly refused = new RecordLog<Refused>();
  /** Ids of messages the runtime has started handing to the agent. */
  public readonly processing = new RecordLog<string>();
  /** Every working report Band accepted, in order. */
  public readonly workingReports = new RecordLog<{ roomId: string; working: boolean }>();
  /** Every working report Band refused, in order. */
  public readonly refusedReports = new RecordLog<{ roomId: string; working: boolean }>();
  /** Band refuses every working report, as it answers 404 while a room has no active execution. */
  public refuseActivity = false;
  /** Ids Band refuses to add to a room with 403, as for someone the agent has no approved contact with. */
  public readonly unreachable = new Set<string>();
  private readonly history: HistoryEntry[] = [];
  private readonly backlog: HistoryEntry[] = [];
  private readonly rooms = new Map<string, RoomState>();
  private lastActivity = 0;
  /** Tells the agent about a room it created, as Band pushes `room_added` to its creator. */
  public onRoomCreated?: (roomId: string) => void;
  public readonly messageHolds = new CallHolds<[roomId: string, content: string]>();
  public readonly processingHolds = new CallHolds<[messageId: string]>();
  public readonly nextMessageHolds = new CallHolds<[roomId: string]>();
  /** Holds a room's participant list in flight; with `error`, Band then refuses it. */
  public readonly participantHolds = new CallHolds<[roomId: string]>();
  /** Holds `getAgentMe`, as a slow platform answers it. */
  public readonly agentMeHolds = new CallHolds<[]>();

  public constructor(private readonly participants: readonly PlatformParticipant[], identity: AgentIdentityOptions = {}) {
    super({}, { id: AGENT_ID, name: "Agent", description: "Flow test agent", handle: AGENT_HANDLE, ...identity });
  }

  public override async getAgentMe(options?: Parameters<RestApi["getAgentMe"]>[0]) {
    await this.agentMeHolds.pass();
    return super.getAgentMe(options);
  }

  /** Every room on one page. */
  public override async listChats(): Promise<PaginatedResponse> {
    return { data: [...this.rooms].map(([roomId, room]) => roomPayload(roomId, "active", room.updatedAt, room.title)), metadata: { page: 1, totalPages: 1 } };
  }

  public async getChat(roomId: string): Promise<ChatRoom> {
    const room = this.assertMember(roomId, "getChat");
    return roomPayload(roomId, "active", room.updatedAt, room.title);
  }

  /** Like Band, only the room's owner, the agent that created it, may rename it; anyone else gets 403. */
  public async renameChat(roomId: string, title: string): Promise<ChatRoom> {
    const room = this.assertMember(roomId, "renameChat");
    if (!room.owned) {
      throw new Band.ForbiddenError({ error: { code: "forbidden", message: "Forbidden", request_id: randomUUID() } });
    }
    room.title = title;
    return roomPayload(roomId, "active", room.updatedAt, title);
  }

  public async reportActivity(roomId: string, working: boolean) {
    this.assertMember(roomId, "reportActivity");
    if (this.refuseActivity) {
      this.refusedReports.record({ roomId, working });
      throw new Band.NotFoundError({ error: { code: "not_found", message: "No active execution", request_id: randomUUID() } });
    }
    this.workingReports.record({ roomId, working });
    return { working };
  }

  /** The oldest backlog message in the room not yet settled, as `/messages/next` serves it. */
  public override async getNextMessage(request: { chatId: string }): Promise<PlatformChatMessage | null> {
    const pending = this.backlog.find((entry) => entry.roomId === request.chatId && !this.isSettled(entry.item.id));
    await this.nextMessageHolds.pass(request.chatId);
    return pending?.item ?? null;
  }

  /** Adds the agent to a room it shares with `participants`; the platform's participants by default. */
  public addRoom(roomId: string, participants: readonly PlatformParticipant[] = this.participants, title?: string): void {
    this.rooms.set(roomId, {
      participants: [AGENT_PARTICIPANT, ...participants], title, updatedAt: this.activity(), tasks: [],
      board: { chat_room_id: roomId, goal_title: null, goal_summary: null, created_by: null, updated_by: null, inserted_at: null, updated_at: null },
    });
  }

  public async getChatBoard(roomId: string, args: Parameters<NonNullable<RestApi["getChatBoard"]>>[1] = {}): Promise<WireBoard> {
    const room = this.boardCall(roomId, "getChatBoard", args);
    return { ...room.board, ...(args.include === "history" ? { history: [], history_truncated: false } : {}) };
  }

  public async putChatBoard(roomId: string, args: Parameters<NonNullable<RestApi["putChatBoard"]>>[1]): Promise<WireBoard> {
    const room = this.boardCall(roomId, "putChatBoard", args);
    room.board = { ...room.board, ...args, created_by: room.board.created_by ?? BOARD_ACTOR, updated_by: BOARD_ACTOR, inserted_at: room.board.inserted_at ?? now(), updated_at: now() };
    return { ...room.board };
  }

  public async listChatTasks(roomId: string, args: Parameters<NonNullable<RestApi["listChatTasks"]>>[1] = {}): Promise<WireTaskPage> {
    const room = this.boardCall(roomId, "listChatTasks", args);
    return { data: room.tasks.map((task) => ({ ...task })), metadata: { next_cursor: null, has_more: false, limit: room.tasks.length } };
  }

  public async createChatTask(roomId: string, args: Parameters<NonNullable<RestApi["createChatTask"]>>[1]): Promise<WireTask> {
    const room = this.boardCall(roomId, "createChatTask", args);
    const task: WireTask = {
      id: randomUUID(), chat_room_id: roomId, number: room.tasks.length + 1, subject: args.subject,
      detail: args.detail ?? "", overall_status: "pending", state: "active", superseded_by_id: null,
      assignments: [], created_by: BOARD_ACTOR, inserted_at: now(), updated_at: now(),
    };
    room.tasks.push(task);
    return { ...task };
  }

  public async getChatTask(roomId: string, id: string, args: Parameters<NonNullable<RestApi["getChatTask"]>>[2] = {}): Promise<WireTask> {
    const room = this.boardCall(roomId, "getChatTask", args, id);
    const task = this.findTask(room, id);
    return { ...task, ...(args.include === "history" ? { history: task.history ?? [], history_truncated: false } : {}) };
  }

  public async updateChatTask(roomId: string, id: string, args: Parameters<NonNullable<RestApi["updateChatTask"]>>[2]): Promise<WireTask> {
    const room = this.boardCall(roomId, "updateChatTask", args, id);
    const task = this.findTask(room, id);
    const { status, active_form, comment, ...edits } = args ?? {};
    Object.assign(task, edits, { updated_at: now() });
    if (status !== undefined || active_form !== undefined) {
      const assignment = task.assignments.find(({ assignee }) => assignee.id === AGENT_ID);
      const updated = { assignee: BOARD_ACTOR, status: status ?? assignment?.status ?? "pending", active_form: active_form ?? assignment?.active_form ?? null, linked_native_id: null, updated_at: now() };
      task.assignments = [...task.assignments.filter(({ assignee }) => assignee.id !== AGENT_ID), updated];
    }
    if (comment !== undefined) {
      task.history = [...(task.history ?? []), { event: "commented", actor: BOARD_ACTOR, payload: { text: comment }, at: now() }];
    }
    return { ...task };
  }

  private boardCall(roomId: string, call: BoardCall["call"], args: unknown, id?: string): RoomState {
    this.boardCalls.record({ roomId, call, args, ...(id === undefined ? {} : { id }) });
    return this.assertMember(roomId, call);
  }

  private findTask(room: RoomState, id: string): WireTask {
    const task = room.tasks.find((task) => task.id === id || String(task.number) === id);
    if (!task) {
      throw new Band.NotFoundError({ error: { code: "not_found", message: "Resource not found", request_id: randomUUID() } });
    }
    return task;
  }

  public removeRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  /** Adds a message to the backlog an agent that is not connected yet finds once it connects. */
  public addBacklog(roomId: string, item: PlatformChatMessage): void {
    this.remember(roomId, item);
    this.backlog.push({ roomId, item });
  }

  /** A room of the agent's own, holding only the agent until it adds someone. */
  public override async createChat(request?: string | CreateChatRequest) {
    const roomId = `created-${randomUUID()}`;
    this.addRoom(roomId, [], typeof request === "string" ? undefined : request?.title);
    this.rooms.get(roomId)!.owned = true;
    this.onRoomCreated?.(roomId);
    return { id: roomId };
  }

  public override async createChatMessage(roomId: string, message: MessageBody) {
    const posted = { roomId, content: message.content, mentions: message.mentions?.map((mention) => mention.id) ?? [], messageType: "text" };
    this.assertMember(roomId, "createChatMessage", posted);
    assertMentioned(message.mentions);
    this.assertDistinctMentions(roomId, posted);
    await this.messageHolds.pass(roomId, message.content);
    this.record(posted);
    return { id: `posted-${this.posted.entries.length}` };
  }

  public override async createChatEvent(roomId: string, event: EventBody) {
    const posted = { roomId, content: event.content, mentions: [], messageType: event.messageType, metadata: event.metadata };
    this.assertMember(roomId, "createChatEvent", posted);
    this.record(posted);
    return { id: `posted-${this.posted.entries.length}` };
  }

  public override async listChatParticipants(roomId: string) {
    await this.participantHolds.pass(roomId);
    return [...this.assertMember(roomId, "listChatParticipants").participants];
  }

  /** Adds someone by id; like Band, 409 for who is already in the room and 403 for who the agent can't reach. */
  public override async addChatParticipant(roomId: string, { participantId }: { participantId: string }) {
    const { participants } = this.assertMember(roomId, "addChatParticipant");
    if (participants.some(({ id }) => id === participantId)) {
      throw new Band.ConflictError({ error: { code: "conflict", message: "Already a participant", request_id: randomUUID() } });
    }
    if (this.unreachable.has(participantId)) {
      throw new Band.ForbiddenError({ error: { code: "forbidden", message: "Forbidden", request_id: randomUUID() } });
    }
    const participant = this.participants.find(({ id }) => id === participantId);
    if (participant) {
      participants.push(participant);
    }
    this.added.record({ roomId, participantId });
    return {};
  }

  public override async removeChatParticipant(roomId: string, participantId: string) {
    const room = this.assertMember(roomId, "removeChatParticipant");
    room.participants = room.participants.filter(({ id }) => id !== participantId);
    return {};
  }

  /** Everyone the agent can add on the first page, then an empty one, leaving out who is already in `notInChat`, as Band's peer list does. */
  public override async listPeers({ page, notInChat }: { page: number; notInChat?: string }): Promise<PaginatedResponse<PeerRecord>> {
    const inRoom = (notInChat && this.rooms.get(notInChat)?.participants) || [];
    const peers = this.participants
      .filter((participant) => !inRoom.some(({ id }) => id === participant.id))
      .map(({ id, name, type, handle, description }) => ({ id, name, type, handle, description }));
    this.peerCalls.record(page);
    await this.peerHolds.pass(page);
    return { data: page === FIRST_PAGE ? peers : [], metadata: { page } };
  }

  /**
   * The room's conversation as the platform hands it to a fresh session, oldest first, a cursor page
   * at a time: what people said and what the agent posted.
   */
  public async getChatContext({ chatId, cursor, limit = DEFAULT_PAGE_SIZE }: { chatId: string } & Partial<CursorPageRequest>): Promise<PaginatedResponse<PlatformChatMessage>> {
    const conversation = this.history.filter((entry) => entry.roomId === chatId).map((entry) => entry.item);
    const start = cursor === undefined ? 0 : Number(cursor);
    const end = start + limit;
    const hasMore = end < conversation.length;
    return { data: conversation.slice(start, end), metadata: { has_more: hasMore, ...(hasMore ? { next_cursor: String(end) } : {}) } };
  }

  public remember(roomId: string, item: PlatformChatMessage): void {
    this.history.push({ roomId, item });
    const room = this.rooms.get(roomId);
    if (room) {
      room.updatedAt = this.activity();
    }
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

  /** The room; Band answers 404 for a room the agent isn't in, whether it left or never joined. */
  private assertMember(roomId: string, call: keyof RestApi, attempt?: Posted): RoomState {
    const room = this.rooms.get(roomId);
    if (!room) {
      this.refused.record({ roomId, call, attempt });
      throw new Band.NotFoundError({ error: { code: "not_found", message: "Resource not found", request_id: randomUUID() } });
    }
    return room;
  }

  /** Band refuses a message that names one participant twice with 422 `duplicate_mentions`. */
  private assertDistinctMentions(roomId: string, posted: Posted): void {
    if (new Set(posted.mentions).size !== posted.mentions.length) {
      this.refused.record({ roomId, call: "createChatMessage", attempt: posted });
      throw new Band.UnprocessableEntityError({ error: { code: "duplicate_mentions", message: "Duplicate mentions", request_id: randomUUID() } });
    }
  }

  /** A timestamp later than every earlier one, so rooms active one after another never tie. */
  private activity(): string {
    this.lastActivity = Math.max(Date.now(), this.lastActivity + 1);
    return new Date(this.lastActivity).toISOString();
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

/** Band's REST API for a key it doesn't know: every identity check is refused with 401. */
class RejectedKeyRestApi extends FakeRestApi {
  public override async getAgentMe(): Promise<never> {
    throw new Band.UnauthorizedError({ error: { code: "unauthorized", message: "Invalid API key", request_id: randomUUID() } });
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

  private constructor(participants: readonly PlatformParticipant[], rest?: RecordingRestApi) {
    this.mentionable = [...participants, AGENT_PARTICIPANT];
    this.rest = rest ?? new RecordingRestApi(participants);
    this.link = { transport: this.transport, restApi: this.rest };
    // Not awaited: Band's push reaches the agent on its own schedule, after the create call returns.
    this.rest.onRoomCreated = (roomId) => void this.announce(roomId);
  }

  /** What a runtime connecting with `apiKey` reaches: this platform for the agent's key, Band's 401 for any other. */
  public linkFor({ apiKey }: { readonly apiKey: string }): { readonly transport: FakeTransport; readonly restApi: FakeRestApi } {
    return apiKey === AGENT_API_KEY ? this.link : { transport: this.transport, restApi: new RejectedKeyRestApi() };
  }

  /** The platform alone, for a host that builds its own runtime on `transport` and `rest`. */
  public static host(participants: readonly PlatformParticipant[], identity?: AgentIdentityOptions): BandPlatform {
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

  /**
   * Adds the agent to a room it shares with `participants`, the platform's by default:
   * a connected agent hears it, one not yet connected finds it in its room list.
   */
  public async room(roomId: string, participants?: readonly PlatformParticipant[]): Promise<BandRoom> {
    this.rest.addRoom(roomId, participants);
    await this.announce(roomId);
    return new BandRoom(roomId, this);
  }

  /** A room the agent created, as `band_create_chatroom` reported it. */
  public created(roomId: string): BandRoom {
    return new BandRoom(roomId, this);
  }

  private async announce(roomId: string): Promise<void> {
    const topic = agentRoomsTopic(AGENT_ID);
    if (this.transport.hasTopic(topic)) {
      await this.transport.emit(topic, "room_added", roomPayload(roomId, "active"));
    }
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

export function agent(id: string, description?: string): PlatformParticipant {
  return { id, name: id, type: "Agent", handle: id, ...(description === undefined ? {} : { description }) };
}
