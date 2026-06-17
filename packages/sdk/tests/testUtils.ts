import type { PlatformMessage } from "../src/runtime";
import type { AgentToolsProtocol } from "../src/core";
import { DEFAULT_AGENT_TOOLS_CAPABILITIES } from "../src/contracts/protocols";
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
    this.events.push({ content, messageType, metadata });
    return { ok: true };
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

export function makeMessage(content: string, roomId = "room-1"): PlatformMessage {
  return {
    id: "msg-1",
    roomId,
    content,
    senderId: "user-1",
    senderType: "User",
    senderName: "User",
    messageType: "text",
    metadata: {},
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
