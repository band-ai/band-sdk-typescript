import type {
  AdapterToolsProtocol,
  AgentToolsCapabilities,
  PeerLookupTools,
  ContactTools,
  MemoryTools,
} from "../contracts/protocols";
import { DEFAULT_AGENT_TOOLS_CAPABILITIES } from "../core";
import type {
  AddContactArgs,
  ContactRecord,
  ContactRequestsResult,
  ListContactRequestsArgs,
  ListContactsArgs,
  ListMemoriesArgs,
  MemoryRecord,
  MentionInput,
  MetadataMap,
  PaginatedList,
  ParticipantRecord,
  PeerRecord,
  RemoveContactArgs,
  RespondContactRequestArgs,
  StoreMemoryArgs,
  ToolOperationResult,
  ToolSchemaRecord,
} from "../contracts/dtos";

interface CapturedMessage {
  content: string;
  mentions?: MentionInput;
}

interface CapturedEvent {
  content: string;
  messageType: string;
  metadata?: MetadataMap;
}

interface CapturedParticipant {
  name: string;
  role?: string;
}

interface CapturedToolCall {
  toolName: string;
  arguments: MetadataMap;
}

type FakeToolMethod = keyof AdapterToolsProtocol;

export interface FakeAgentToolsOptions {
  failOn?: Iterable<FakeToolMethod>;
  errorFactory?: (method: FakeToolMethod) => Error;
}

export class FakeAgentTools
  implements AdapterToolsProtocol, PeerLookupTools, ContactTools, MemoryTools
{
  public readonly capabilities: Readonly<AgentToolsCapabilities> = {
    ...DEFAULT_AGENT_TOOLS_CAPABILITIES,
    peers: true,
    contacts: true,
    memory: true,
  };
  public messagesSent: CapturedMessage[] = [];
  public eventsSent: CapturedEvent[] = [];
  public participantsAdded: CapturedParticipant[] = [];
  public participantsRemoved: string[] = [];
  public toolCalls: CapturedToolCall[] = [];

  private messageCounter = 0;
  private eventCounter = 0;
  private readonly failOn: Set<FakeToolMethod>;
  private readonly errorFactory: (method: FakeToolMethod) => Error;

  public constructor(options?: FakeAgentToolsOptions) {
    this.failOn = new Set(options?.failOn ?? []);
    this.errorFactory =
      options?.errorFactory ??
      ((method) => new Error(`FakeAgentTools configured failure for ${String(method)}`));
  }

  public async sendMessage(
    content: string,
    mentions?: MentionInput,
  ): Promise<ToolOperationResult> {
    this.maybeFail("sendMessage");
    this.messagesSent.push({ content, mentions });
    const id = `msg-${this.messageCounter++}`;
    return { id, status: "sent" };
  }

  public async sendEvent(
    content: string,
    messageType: string,
    metadata?: MetadataMap,
  ): Promise<ToolOperationResult> {
    this.maybeFail("sendEvent");
    this.eventsSent.push({ content, messageType, metadata });
    const id = `evt-${this.eventCounter++}`;
    return { id, status: "sent" };
  }

  public async addParticipant(
    name: string,
    role?: string,
  ): Promise<ToolOperationResult> {
    this.maybeFail("addParticipant");
    this.participantsAdded.push({ name, role });
    return { status: "ok" };
  }

  public async removeParticipant(name: string): Promise<ToolOperationResult> {
    this.maybeFail("removeParticipant");
    this.participantsRemoved.push(name);
    return { status: "ok" };
  }

  public async getParticipants(): Promise<ParticipantRecord[]> {
    this.maybeFail("getParticipants");
    return [];
  }

  public async createChatroom(_taskId?: string): Promise<string> {
    this.maybeFail("createChatroom");
    return `room-${Date.now()}`;
  }

  public async lookupPeers(
    _page?: number,
    _pageSize?: number,
  ): Promise<PaginatedList<PeerRecord>> {
    this.maybeFail("lookupPeers");
    return { data: [] };
  }

  public getToolSchemas(
    _format: "openai" | "anthropic",
    _options?: { includeMemory?: boolean },
  ): ToolSchemaRecord[] {
    this.maybeFail("getToolSchemas");
    return [];
  }

  public getAnthropicToolSchemas(
    _options?: { includeMemory?: boolean },
  ): ToolSchemaRecord[] {
    this.maybeFail("getAnthropicToolSchemas");
    return [];
  }

  public getOpenAIToolSchemas(
    _options?: { includeMemory?: boolean },
  ): ToolSchemaRecord[] {
    this.maybeFail("getOpenAIToolSchemas");
    return [];
  }

  public async executeToolCall(
    toolName: string,
    arguments_: MetadataMap,
  ): Promise<unknown> {
    this.maybeFail("executeToolCall");
    this.toolCalls.push({ toolName, arguments: arguments_ });
    return { status: "ok" };
  }

  // Contact stubs
  public async listContacts(
    _request?: ListContactsArgs,
  ): Promise<PaginatedList<ContactRecord>> {
    this.maybeFail("listContacts");
    return { data: [] };
  }

  public async addContact(
    _request: AddContactArgs,
  ): Promise<ToolOperationResult> {
    this.maybeFail("addContact");
    return { status: "ok" };
  }

  public async removeContact(
    _request: RemoveContactArgs,
  ): Promise<ToolOperationResult> {
    this.maybeFail("removeContact");
    return { status: "ok" };
  }

  public async listContactRequests(
    _request?: ListContactRequestsArgs,
  ): Promise<ContactRequestsResult> {
    this.maybeFail("listContactRequests");
    return { received: [], sent: [] };
  }

  public async respondContactRequest(
    _request: RespondContactRequestArgs,
  ): Promise<ToolOperationResult> {
    this.maybeFail("respondContactRequest");
    return { status: "ok" };
  }

  // Memory stubs
  public async listMemories(
    _args?: ListMemoriesArgs,
  ): Promise<PaginatedList<MemoryRecord>> {
    this.maybeFail("listMemories");
    return { data: [] };
  }

  public async storeMemory(args: StoreMemoryArgs): Promise<MemoryRecord> {
    this.maybeFail("storeMemory");
    return { ...args, id: "mem-0", status: "active" };
  }

  public async getMemory(memoryId: string): Promise<MemoryRecord> {
    this.maybeFail("getMemory");
    return { id: memoryId, status: "active" };
  }

  public async supersedeMemory(
    _memoryId: string,
  ): Promise<ToolOperationResult> {
    this.maybeFail("supersedeMemory");
    return { status: "ok" };
  }

  public async archiveMemory(
    _memoryId: string,
  ): Promise<ToolOperationResult> {
    this.maybeFail("archiveMemory");
    return { status: "ok" };
  }

  public reset(): void {
    this.messagesSent.length = 0;
    this.eventsSent.length = 0;
    this.participantsAdded.length = 0;
    this.participantsRemoved.length = 0;
    this.toolCalls.length = 0;
    this.messageCounter = 0;
    this.eventCounter = 0;
  }

  private maybeFail(method: FakeToolMethod): void {
    if (this.failOn.has(method)) {
      throw this.errorFactory(method);
    }
  }
}
