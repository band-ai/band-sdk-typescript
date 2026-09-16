import { ProviderTurnFailedError } from "../src/core/providerFailure";
import { expect } from "vitest";
import { ParticipantRoster, type AgentFailure } from "@band-ai/band-sdk-core";
import type { PlatformMessage } from "../src/runtime";
import type { AgentToolsProtocol } from "../src/core";
import { DEFAULT_AGENT_TOOLS_CAPABILITIES, FAILURE_EVENT_TYPE, toFailureEvent } from "../src/contracts/protocols";
import { isBlankEventContent } from "../src/contracts/chatEvents";
import type {
  AgentIdentity,
  PaginatedResponse,
  PlatformChatMessage,
  RestApi,
} from "../src/client/rest/types";
import type {
  PaginatedList,
  ParticipantRecord,
  PeerRecord,
} from "../src/contracts/dtos";
import type {
  ReconnectObserver,
  ReconnectSnapshot,
  StreamingTransport,
  TopicHandlers,
} from "../src/platform/streaming/transport";

interface CapturedToolEvent {
  content: string;
  messageType: string;
  metadata?: Record<string, unknown>;
}

type FakeToolMethod = keyof AgentToolsProtocol;

interface FakeToolsOptions {
  failOn?: Iterable<FakeToolMethod>;
  errorFactory?: (method: FakeToolMethod) => Error;
}

export class FakeTools implements AgentToolsProtocol {
  public readonly capabilities = { ...DEFAULT_AGENT_TOOLS_CAPABILITIES };
  public readonly messages: string[] = [];
  public readonly events: CapturedToolEvent[] = [];
  public rest?: Pick<RestApi, "getAgentMe" | "listChats">;
  private readonly failOn: Set<FakeToolMethod>;
  private readonly errorFactory: (method: FakeToolMethod) => Error;

  public constructor(options?: FakeToolsOptions) {
    this.failOn = new Set(options?.failOn ?? []);
    this.errorFactory =
      options?.errorFactory ??
      ((method) => new Error(`FakeTools configured failure for ${String(method)}`));
  }

  public async sendMessage(
    content: string,
    _mentions?: string[] | Array<{ id: string; handle?: string }>,
  ): Promise<Record<string, unknown>> {
    this.maybeFail("sendMessage");
    this.messages.push(content);
    return { ok: true };
  }

  public async sendEvent(
    content: string,
    messageType: string,
    metadata?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.maybeFail("sendEvent");
    // Mirrors the platform's own rejection, so a test posting a blank chunk
    // is an actual regression test rather than a vacuous pass.
    if (isBlankEventContent(content)) {
      return { ok: false, status: "failed" };
    }
    this.events.push({ content, messageType, metadata });
    return { ok: true };
  }

  public async sendFailure(failure: AgentFailure): Promise<Record<string, unknown>> {
    this.maybeFail("sendFailure");
    const { content, messageType, metadata } = toFailureEvent(failure);
    return this.sendEvent(content, messageType, metadata);
  }

  public async addParticipant(_name: string, _role?: string): Promise<Record<string, unknown>> {
    this.maybeFail("addParticipant");
    return { ok: true };
  }

  public async removeParticipant(_name: string): Promise<Record<string, unknown>> {
    this.maybeFail("removeParticipant");
    return { ok: true };
  }

  public async getParticipants(): Promise<ParticipantRecord[]> {
    this.maybeFail("getParticipants");
    return [];
  }

  public async lookupPeers(_page?: number, _pageSize?: number): Promise<PaginatedList<PeerRecord>> {
    this.maybeFail("lookupPeers");
    return { data: [] };
  }

  public async createChatroom(_taskId?: string): Promise<string> {
    this.maybeFail("createChatroom");
    return "room";
  }

  public getToolSchemas(
    _format: "openai" | "anthropic",
    _options?: { includeMemory?: boolean },
  ): Array<Record<string, unknown>> {
    this.maybeFail("getToolSchemas");
    return [];
  }

  public getAnthropicToolSchemas(_options?: { includeMemory?: boolean }): Array<Record<string, unknown>> {
    this.maybeFail("getAnthropicToolSchemas");
    return [];
  }

  public getOpenAIToolSchemas(_options?: { includeMemory?: boolean }): Array<Record<string, unknown>> {
    this.maybeFail("getOpenAIToolSchemas");
    return [];
  }

  public async executeToolCall(_toolName: string, _arguments: Record<string, unknown>): Promise<unknown> {
    this.maybeFail("executeToolCall");
    return { ok: true };
  }

  private maybeFail(method: FakeToolMethod): void {
    if (this.failOn.has(method)) {
      throw this.errorFactory(method);
    }
  }
}

/** The failure event an adapter posted, located the way a client locates one. */
export function findFailureEvent(tools: FakeTools): CapturedToolEvent | undefined {
  return tools.events.find((event) => event.messageType === FAILURE_EVENT_TYPE);
}

export function makeRoster(participants: ParticipantRecord[]): ParticipantRoster {
  const roster = new ParticipantRoster();
  roster.setAll(participants);
  return roster;
}

type JoinLeaveOutcome = "ok" | "error";

/** Fake `StreamingTransport` driven by `emit(...)`, standing in for the network only. */
export class FakeTransport implements StreamingTransport {
  public readonly joinCalls: string[] = [];
  public readonly leaveCalls: string[] = [];
  /** Every currently-registered reconnect observer — a real transport only ever settles once per generation, but exposing the full set (rather than the last-registered one) lets a test assert exactly how many a caller has live at once. */
  public readonly observers = new Set<ReconnectObserver>();
  public disconnectCount = 0;
  private readonly handlers = new Map<string, TopicHandlers>();
  private connected = false;
  private readonly joinOutcomes = new Map<string, JoinLeaveOutcome>();
  private readonly leaveOutcomes = new Map<string, JoinLeaveOutcome>();
  private readonly joinGates = new Map<string, Promise<void>>();
  private readonly leaveGates = new Map<string, Promise<void>>();
  private connectGate: Promise<void> = Promise.resolve();
  private releaseConnectGate: (() => void) | null = null;
  private connectError: unknown = null;

  public async connect(): Promise<void> {
    await this.connectGate;
    if (this.connectError) {
      throw this.connectError;
    }
    this.connected = true;
  }

  /** Makes every future `connect()` call reject with `error` until cleared. */
  public failConnect(error: unknown): void {
    this.connectError = error;
  }

  public clearConnectFailure(): void {
    this.connectError = null;
  }

  public async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    this.connected = false;
  }

  /** Blocks every `connect()` call until the returned function runs. */
  public gateConnect(): void {
    this.connectGate = new Promise((resolve) => {
      this.releaseConnectGate = resolve;
    });
  }

  public releaseConnection(): void {
    this.releaseConnectGate?.();
    this.releaseConnectGate = null;
  }

  public async join(topic: string, handlers: TopicHandlers): Promise<void> {
    this.joinCalls.push(topic);
    // Mirrors the real transport's `if (this.channels.has(topic)) { return; }`
    // fast path: once a topic is bound, a later join() call must not silently
    // rebind it to different handlers.
    if (this.handlers.has(topic)) {
      return;
    }
    const gate = this.joinGates.get(topic);
    if (gate) {
      await gate;
    }
    if (this.joinOutcomes.get(topic) === "error") {
      throw new Error(`join failed: ${topic}`);
    }
    this.handlers.set(topic, handlers);
  }

  public async leave(topic: string): Promise<void> {
    this.leaveCalls.push(topic);
    const gate = this.leaveGates.get(topic);
    if (gate) {
      await gate;
    }
    if (this.leaveOutcomes.get(topic) === "error") {
      throw new Error(`leave failed: ${topic}`);
    }
    this.handlers.delete(topic);
  }

  private gate(gates: Map<string, Promise<void>>, topic: string): () => void {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.set(topic, gate);
    return () => {
      gates.delete(topic);
      release();
    };
  }

  /** Blocks every `join(topic, ...)` call until the returned function runs. */
  public gateJoin(topic: string): () => void {
    return this.gate(this.joinGates, topic);
  }

  public gateLeave(topic: string): () => void {
    return this.gate(this.leaveGates, topic);
  }

  private setOutcome(outcomes: Map<string, JoinLeaveOutcome>, topic: string, outcome: JoinLeaveOutcome): void {
    outcomes.set(topic, outcome);
  }

  private clearOutcome(outcomes: Map<string, JoinLeaveOutcome>, topic: string): void {
    outcomes.delete(topic);
  }

  public failJoin(topic: string): void {
    this.setOutcome(this.joinOutcomes, topic, "error");
  }

  public failLeave(topic: string): void {
    this.setOutcome(this.leaveOutcomes, topic, "error");
  }

  public clearJoinFailure(topic: string): void {
    this.clearOutcome(this.joinOutcomes, topic);
  }

  public clearLeaveFailure(topic: string): void {
    this.clearOutcome(this.leaveOutcomes, topic);
  }

  public joinCountOf(topic: string): number {
    return this.joinCalls.filter((t) => t === topic).length;
  }

  public async runForever(signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return;
    }
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }

  public async emit(topic: string, event: string, payload: Record<string, unknown>): Promise<void> {
    const topicHandlers = this.handlers.get(topic);
    const handler = topicHandlers?.[event];
    if (!handler) {
      throw new Error(`No handler for ${topic}/${event}`);
    }

    await Promise.resolve(handler(payload));
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public hasTopic(topic: string): boolean {
    return this.handlers.has(topic);
  }

  public onReconnected(observer: ReconnectObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  /** Simulates a settled transport-level reconnect for tests driving BandLink's observer(s). */
  public async triggerReconnect(
    snapshot: Omit<ReconnectSnapshot, "attemptedTopics"> &
      Partial<Pick<ReconnectSnapshot, "attemptedTopics">>,
  ): Promise<void> {
    const full: ReconnectSnapshot = {
      ...snapshot,
      attemptedTopics: snapshot.attemptedTopics ?? snapshot.joinedTopics,
    };
    await Promise.all([...this.observers].map((observer) => observer(full)));
  }
}

export function makeMessage(content: string, roomId = "room-1", metadata: Record<string, unknown> = {}): PlatformMessage {
  return {
    id: "msg-1",
    roomId,
    content,
    senderId: "user-1",
    senderType: "User",
    senderName: "User",
    messageType: "text",
    metadata,
    createdAt: new Date("2026-03-02T00:00:00.000Z"),
  };
}

type FakeRestApiOverrides = Partial<RestApi>;

export class FakeRestApi implements RestApi {
  private readonly overrides: FakeRestApiOverrides;
  private readonly identity: AgentIdentity;

  public constructor(overrides: FakeRestApiOverrides = {}, identity?: AgentIdentity) {
    this.overrides = overrides;
    this.identity = identity ?? { id: "agent-1", name: "Agent", description: null };
  }

  public async getAgentMe(options?: Parameters<RestApi["getAgentMe"]>[0]) {
    return this.overrides.getAgentMe?.(options) ?? this.identity;
  }

  public async createChatMessage(
    chatId: string,
    message: Parameters<RestApi["createChatMessage"]>[1],
    options?: Parameters<RestApi["createChatMessage"]>[2],
  ) {
    return this.overrides.createChatMessage?.(chatId, message, options) ?? {};
  }

  public async createChatEvent(
    chatId: string,
    event: Parameters<RestApi["createChatEvent"]>[1],
    options?: Parameters<RestApi["createChatEvent"]>[2],
  ) {
    return this.overrides.createChatEvent?.(chatId, event, options) ?? {};
  }

  public async createChat(
    taskId?: Parameters<RestApi["createChat"]>[0],
    options?: Parameters<RestApi["createChat"]>[1],
  ) {
    return this.overrides.createChat?.(taskId, options) ?? { id: "room-1" };
  }

  public async listChatParticipants(
    chatId: string,
    options?: Parameters<RestApi["listChatParticipants"]>[1],
  ) {
    return this.overrides.listChatParticipants?.(chatId, options) ?? [];
  }

  public async addChatParticipant(
    chatId: string,
    participant: Parameters<RestApi["addChatParticipant"]>[1],
    options?: Parameters<RestApi["addChatParticipant"]>[2],
  ) {
    return this.overrides.addChatParticipant?.(chatId, participant, options) ?? {};
  }

  public async removeChatParticipant(
    chatId: string,
    participantId: string,
    options?: Parameters<RestApi["removeChatParticipant"]>[2],
  ) {
    return this.overrides.removeChatParticipant?.(chatId, participantId, options) ?? {};
  }

  public async markMessageProcessing(
    chatId: string,
    messageId: string,
    options?: Parameters<RestApi["markMessageProcessing"]>[2],
  ) {
    return this.overrides.markMessageProcessing?.(chatId, messageId, options) ?? {};
  }

  public async markMessageProcessed(
    chatId: string,
    messageId: string,
    options?: Parameters<RestApi["markMessageProcessed"]>[2],
  ) {
    return this.overrides.markMessageProcessed?.(chatId, messageId, options) ?? {};
  }

  public async markMessageFailed(
    chatId: string,
    messageId: string,
    error: string,
    options?: Parameters<RestApi["markMessageFailed"]>[3],
  ) {
    return this.overrides.markMessageFailed?.(chatId, messageId, error, options) ?? {};
  }

  public async listPeers(
    request: Parameters<NonNullable<RestApi["listPeers"]>>[0],
    options?: Parameters<NonNullable<RestApi["listPeers"]>>[1],
  ) {
    return this.overrides.listPeers?.(request, options) ?? { data: [] };
  }

  public async listChats(
    request: Parameters<NonNullable<RestApi["listChats"]>>[0],
    options?: Parameters<NonNullable<RestApi["listChats"]>>[1],
  ): Promise<PaginatedResponse> {
    if (this.overrides.listChats) {
      return this.overrides.listChats(request, options);
    }

    return { data: [] };
  }

  public async listMessages(
    request: Parameters<NonNullable<RestApi["listMessages"]>>[0],
    options?: Parameters<NonNullable<RestApi["listMessages"]>>[1],
  ): Promise<PaginatedResponse<PlatformChatMessage>> {
    if (this.overrides.listMessages) {
      return this.overrides.listMessages(request, options);
    }

    return { data: [] };
  }

  public async getNextMessage(
    request: Parameters<NonNullable<RestApi["getNextMessage"]>>[0],
    options?: Parameters<NonNullable<RestApi["getNextMessage"]>>[1],
  ): Promise<PlatformChatMessage | null> {
    return this.overrides.getNextMessage?.(request, options) ?? null;
  }

}

/**
 * A terminal provider failure reports to the room and then fails the turn, so
 * `PlatformRuntime` still marks the message failed and the platform still
 * re-syncs it. Returning instead would silently flip a failed turn to
 * `processed` and drop its retry — see `ProviderTurnFailedError`.
 */
export async function expectTurnFailed(turn: Promise<unknown>): Promise<void> {
  await expect(turn).rejects.toBeInstanceOf(ProviderTurnFailedError);
}
