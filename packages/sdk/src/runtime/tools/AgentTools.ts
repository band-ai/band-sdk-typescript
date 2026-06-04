import { UnsupportedFeatureError, ValidationError } from "../../core/errors";
import type { AgentToolsRestApi } from "../../client/rest/types";
import { DEFAULT_REQUEST_OPTIONS } from "../../client/rest/requestOptions";
import { assertCapability } from "../../contracts/capabilities";
import { assertChatEventType, CHAT_EVENT_TYPES } from "../../contracts/chatEvents";
import type {
  AddContactArgs,
  ContactRecord,
  ContactRequestsResult,
  ListContactRequestsArgs,
  ListContactsArgs,
  ListMemoriesArgs,
  MemoryScope,
  MemorySegment,
  MemoryStatus,
  MemorySystem,
  MemoryType,
  MemoryRecord,
  MentionInput,
  MentionReference,
  MetadataMap,
  PaginatedList,
  ParticipantRecord,
  PeerRecord,
  RemoveContactArgs,
  RespondContactRequestArgs,
  StoreMemoryArgs,
  ToolOperationResult,
  ToolSchemaRecord,
} from "../../contracts/dtos";
import {
  type AdapterToolsProtocol,
  createToolExecutorError,
  DEFAULT_AGENT_TOOLS_CAPABILITIES,
  type AgentToolsCapabilities,
  type AgentToolsProtocol,
  isToolExecutorError,
  type ToolExecutorError,
} from "../../contracts/protocols";
import {
  CHAT_TOOL_NAMES,
  MEMORY_TOOL_NAMES,
  getToolDescription,
  TOOL_MODELS
} from "./schemas";

interface AgentToolsOptions {
  roomId: string;
  rest: AgentToolsRestApi;
  participants?: ParticipantRecord[];
  capabilities?: Partial<AgentToolsCapabilities>;
}

type ToolHandler = (arguments_: MetadataMap) => Promise<unknown>;

type AdapterToolMethodName =
  | "sendMessage"
  | "sendEvent"
  | "addParticipant"
  | "removeParticipant"
  | "getParticipants"
  | "createChatroom"
  | "getToolSchemas"
  | "getAnthropicToolSchemas"
  | "getOpenAIToolSchemas"
  | "executeToolCall"
  | "lookupPeers"
  | "listContacts"
  | "addContact"
  | "removeContact"
  | "listContactRequests"
  | "respondContactRequest"
  | "listMemories"
  | "storeMemory"
  | "getMemory"
  | "supersedeMemory"
  | "archiveMemory";

const REQUIRED_ADAPTER_TOOL_METHODS = [
  "sendMessage",
  "sendEvent",
  "addParticipant",
  "removeParticipant",
  "getParticipants",
  "createChatroom",
  "getToolSchemas",
  "getAnthropicToolSchemas",
  "getOpenAIToolSchemas",
  "executeToolCall",
] as const satisfies readonly AdapterToolMethodName[];

const OPTIONAL_ADAPTER_TOOL_METHODS: Record<keyof AgentToolsCapabilities, readonly AdapterToolMethodName[]> = {
  peers: ["lookupPeers"],
  contacts: [
    "listContacts",
    "addContact",
    "removeContact",
    "listContactRequests",
    "respondContactRequest",
  ],
  memory: [
    "listMemories",
    "storeMemory",
    "getMemory",
    "supersedeMemory",
    "archiveMemory",
  ],
};

const CONTACT_REQUEST_ACTIONS: ReadonlySet<RespondContactRequestArgs["action"]> = new Set([
  "approve",
  "reject",
  "cancel",
]);

const MEMORY_SYSTEMS: ReadonlySet<StoreMemoryArgs["system"]> = new Set([
  "sensory",
  "working",
  "long_term",
]);

const MEMORY_TYPES: ReadonlySet<StoreMemoryArgs["type"]> = new Set([
  "iconic",
  "echoic",
  "haptic",
  "episodic",
  "semantic",
  "procedural",
]);

const MEMORY_SEGMENTS: ReadonlySet<StoreMemoryArgs["segment"]> = new Set([
  "user",
  "agent",
  "tool",
  "guideline",
]);

const LIST_MEMORY_SCOPES: ReadonlySet<MemoryScope> = new Set([
  "subject",
  "organization",
  "all",
]);

const LIST_MEMORY_STATUSES: ReadonlySet<MemoryStatus> = new Set([
  "active",
  "superseded",
  "archived",
  "all",
]);

const MEMORY_SCOPES: ReadonlySet<NonNullable<StoreMemoryArgs["scope"]>> = new Set([
  "subject",
  "organization",
]);

export class AgentTools implements AgentToolsProtocol {
  public readonly roomId: string;
  public readonly capabilities: Readonly<AgentToolsCapabilities>;
  private readonly rest: AgentToolsRestApi;
  private participants: ParticipantRecord[];
  private readonly adapterTools: AdapterToolsProtocol;
  private readonly toolHandlers: Record<string, ToolHandler>;

  public constructor(options: AgentToolsOptions) {
    this.roomId = options.roomId;
    this.rest = options.rest;
    this.participants = options.participants ?? [];
    this.capabilities = {
      ...DEFAULT_AGENT_TOOLS_CAPABILITIES,
      ...options.capabilities,
    };
    this.toolHandlers = this.buildToolHandlers();
    this.adapterTools = this.buildAdapterTools();
  }

  public getAdapterTools(): AdapterToolsProtocol {
    return this.adapterTools;
  }

  public async sendMessage(
    content: string,
    mentions: MentionInput = [],
  ): Promise<ToolOperationResult> {
    if (mentions.length > 0 && typeof mentions[0] === "string" && this.participants.length === 0) {
      await this.syncParticipants();
    }

    const resolvedMentions = this.resolveMentions(mentions);

    return this.rest.createChatMessage(
      this.roomId,
      {
        content,
        mentions: resolvedMentions,
      },
      DEFAULT_REQUEST_OPTIONS,
    );
  }

  public async sendEvent(
    content: string,
    messageType: string,
    metadata?: MetadataMap,
  ): Promise<ToolOperationResult> {
    assertChatEventType(messageType);
    return this.rest.createChatEvent(
      this.roomId,
      {
        content,
        messageType,
        metadata,
      },
      DEFAULT_REQUEST_OPTIONS,
    );
  }

  public async createChatroom(taskId?: string): Promise<string> {
    const room = await this.rest.createChat(taskId, DEFAULT_REQUEST_OPTIONS);
    return room.id;
  }

  public async addParticipant(name: string, role = "member"): Promise<ToolOperationResult> {
    const existing = await this.syncParticipants();
    const alreadyInRoom = existing.find(
      (participant) => String(participant.name ?? "").toLowerCase() === name.toLowerCase(),
    );
    if (alreadyInRoom) {
      return {
        ...alreadyInRoom,
        status: "already_in_room",
      };
    }

    const peer = await this.lookupPeerByName(name);
    if (!peer?.id) {
      throw new UnsupportedFeatureError(
        `Participant '${name}' not found. lookupPeers requires peer endpoint availability.`,
      );
    }

    await this.rest.addChatParticipant(
      this.roomId,
      {
        participantId: String(peer.id),
        role,
      },
      DEFAULT_REQUEST_OPTIONS,
    );

    const participantRecord = {
      id: String(peer.id),
      name,
      role,
      type: String(peer.type ?? "Agent"),
      handle: typeof peer.handle === "string" ? peer.handle : null,
    };

    this.participants.push(participantRecord);

    return {
      ...participantRecord,
      status: "added",
    };
  }

  public async removeParticipant(name: string): Promise<ToolOperationResult> {
    const participants = await this.syncParticipants();
    const participant = participants.find(
      (entry) => String(entry.name ?? "").toLowerCase() === name.toLowerCase(),
    );

    if (!participant?.id) {
      throw new ValidationError(`Participant '${name}' not found in room`);
    }

    await this.rest.removeChatParticipant(this.roomId, String(participant.id), DEFAULT_REQUEST_OPTIONS);
    this.replaceParticipants(this.participants.filter((entry) => entry.id !== participant.id));

    return {
      id: participant.id,
      name,
      status: "removed",
    };
  }

  public async lookupPeers(page = 1, pageSize = 50): Promise<PaginatedList<PeerRecord>> {
    assertCapability(this.capabilities, "peers");
    if (!this.rest.listPeers) {
      throw new UnsupportedFeatureError(
        "Peer listing is not available in current REST adapter",
      );
    }

    return this.rest.listPeers(
      {
        page,
        pageSize,
        notInChat: this.roomId,
      },
      DEFAULT_REQUEST_OPTIONS,
    );
  }

  public async getParticipants(): Promise<ParticipantRecord[]> {
    return this.fetchParticipants();
  }

  private async fetchParticipants(): Promise<ParticipantRecord[]> {
    const participants = await this.rest.listChatParticipants(this.roomId, DEFAULT_REQUEST_OPTIONS);
    return participants.map((participant) => ({
      id: participant.id,
      name: participant.name,
      type: participant.type,
      handle: participant.handle ?? null,
    }));
  }

  private async syncParticipants(): Promise<ParticipantRecord[]> {
    const participants = await this.fetchParticipants();
    this.replaceParticipants(participants);
    return [...this.participants];
  }

  public async executeToolCall(toolName: string, arguments_: MetadataMap): Promise<unknown> {
    const validationError = validateToolArgs(toolName, arguments_);
    if (validationError) {
      return validationError;
    }

    const handler = this.toolHandlers[toolName];
    if (!handler) {
      return createToolExecutorError({
        errorType: "ToolNotFoundError",
        toolName,
        message: `Tool '${toolName}' is not registered`,
        legacyMessage: `Unknown tool: ${toolName}`,
      });
    }

    try {
      return await handler(arguments_);
    } catch (error) {
      if (isToolExecutorError(error)) {
        return error;
      }

      if (error instanceof ValidationError) {
        return createToolExecutorError({
          errorType: "ToolArgumentsValidationError",
          toolName,
          message: error.message,
          legacyMessage: `Invalid arguments for ${toolName}: ${error.message}`,
        });
      }

      const message = error instanceof Error ? error.message : String(error);
      return createToolExecutorError({
        errorType: "ToolExecutionError",
        toolName,
        message,
        legacyMessage: `Error executing ${toolName}: ${message}`,
      });
    }
  }

  public getToolSchemas(format: "openai" | "anthropic", options?: { includeMemory?: boolean }): ToolSchemaRecord[] {
    const includeMemory = options?.includeMemory ?? false;

    const tools = Object.entries(TOOL_MODELS)
      .filter(([name]) => {
        if (MEMORY_TOOL_NAMES.has(name)) {
          return includeMemory && this.capabilities.memory;
        }

        if (!CHAT_TOOL_NAMES.has(name) && !this.capabilities.contacts) {
          return false;
        }

        if (name === "thenvoi_lookup_peers" && !this.capabilities.peers) {
          return false;
        }

        return true;
      })
      .map(([name, model]) => {
        if (format === "anthropic") {
          return {
            name,
            description: getToolDescription(name),
            input_schema: {
              type: "object",
              properties: model.properties,
              required: model.required,
            },
          };
        }

        return {
          type: "function",
          function: {
            name,
            description: getToolDescription(name),
            parameters: {
              type: "object",
              properties: model.properties,
              required: model.required,
            },
          },
        };
      });

    return tools;
  }

  public getAnthropicToolSchemas(options?: { includeMemory?: boolean }): ToolSchemaRecord[] {
    return this.getToolSchemas("anthropic", options);
  }

  public getOpenAIToolSchemas(options?: { includeMemory?: boolean }): ToolSchemaRecord[] {
    return this.getToolSchemas("openai", options);
  }

  public async listContacts(request: ListContactsArgs = {}): Promise<PaginatedList<ContactRecord>> {
    assertCapability(this.capabilities, "contacts");
    if (!this.rest.listContacts) {
      throw new UnsupportedFeatureError("Contact listing is not available in current REST adapter");
    }

    const page = request.page ?? 1;
    const pageSize = request.pageSize ?? 50;

    return this.rest.listContacts(
      {
        page,
        pageSize,
      },
      DEFAULT_REQUEST_OPTIONS,
    );
  }

  public async addContact(request: AddContactArgs): Promise<ToolOperationResult> {
    assertCapability(this.capabilities, "contacts");
    if (!this.rest.addContact) {
      throw new UnsupportedFeatureError("Contact creation is not available in current REST adapter");
    }

    const normalizedHandle = request.handle.trim();
    if (normalizedHandle.length === 0) {
      throw new ValidationError("handle is required");
    }

    return this.rest.addContact(
      {
        handle: normalizedHandle,
        ...(request.message ? { message: request.message } : {}),
      },
      DEFAULT_REQUEST_OPTIONS,
    );
  }

  public async removeContact(request: RemoveContactArgs): Promise<ToolOperationResult> {
    assertCapability(this.capabilities, "contacts");
    if (!this.rest.removeContact) {
      throw new UnsupportedFeatureError("Contact removal is not available in current REST adapter");
    }

    if (request.target === "handle") {
      const handle = request.handle.trim();
      if (handle.length === 0) {
        throw new ValidationError("handle is required");
      }

      return this.rest.removeContact(
        {
          target: "handle",
          handle,
        },
        DEFAULT_REQUEST_OPTIONS,
      );
    }

    const contactId = request.contactId.trim();
    if (contactId.length === 0) {
      throw new ValidationError("contactId is required");
    }

    return this.rest.removeContact(
      {
        target: "contactId",
        contactId,
      },
      DEFAULT_REQUEST_OPTIONS,
    );
  }

  public async listContactRequests(
    request: ListContactRequestsArgs = {},
  ): Promise<ContactRequestsResult> {
    assertCapability(this.capabilities, "contacts");
    if (!this.rest.listContactRequests) {
      throw new UnsupportedFeatureError("Contact request listing is not available in current REST adapter");
    }

    const page = request.page ?? 1;
    const pageSize = request.pageSize ?? 50;
    const sentStatus = request.sentStatus ?? "pending";

    return this.rest.listContactRequests(
      {
        page,
        pageSize,
        sentStatus,
      },
      DEFAULT_REQUEST_OPTIONS,
    );
  }

  public async respondContactRequest(request: RespondContactRequestArgs): Promise<ToolOperationResult> {
    assertCapability(this.capabilities, "contacts");
    if (!this.rest.respondContactRequest) {
      throw new UnsupportedFeatureError("Contact request responses are not available in current REST adapter");
    }

    if (request.target === "handle") {
      const handle = request.handle.trim();
      if (handle.length === 0) {
        throw new ValidationError("handle is required");
      }

      return this.rest.respondContactRequest(
        {
          action: request.action,
          target: "handle",
          handle,
        },
        DEFAULT_REQUEST_OPTIONS,
      );
    }

    const requestId = request.requestId.trim();
    if (requestId.length === 0) {
      throw new ValidationError("requestId is required");
    }

    return this.rest.respondContactRequest(
      {
        action: request.action,
        target: "requestId",
        requestId,
      },
      DEFAULT_REQUEST_OPTIONS,
    );
  }

  public async listMemories(args: ListMemoriesArgs = {}): Promise<PaginatedList<MemoryRecord>> {
    assertCapability(this.capabilities, "memory");
    if (!this.rest.listMemories) {
      throw new UnsupportedFeatureError("Memory listing is not available in current REST adapter");
    }

    return this.rest.listMemories(args, DEFAULT_REQUEST_OPTIONS);
  }

  public async storeMemory(args: StoreMemoryArgs): Promise<MemoryRecord> {
    assertCapability(this.capabilities, "memory");
    if (!this.rest.storeMemory) {
      throw new UnsupportedFeatureError("Memory creation is not available in current REST adapter");
    }

    return this.rest.storeMemory(args, DEFAULT_REQUEST_OPTIONS);
  }

  public async getMemory(memoryId: string): Promise<MemoryRecord> {
    assertCapability(this.capabilities, "memory");
    if (!this.rest.getMemory) {
      throw new UnsupportedFeatureError("Memory lookup is not available in current REST adapter");
    }

    const normalizedMemoryId = memoryId.trim();
    if (normalizedMemoryId.length === 0) {
      throw new ValidationError("memoryId is required");
    }

    return this.rest.getMemory(normalizedMemoryId, DEFAULT_REQUEST_OPTIONS);
  }

  public async supersedeMemory(memoryId: string): Promise<ToolOperationResult> {
    assertCapability(this.capabilities, "memory");
    if (!this.rest.supersedeMemory) {
      throw new UnsupportedFeatureError("Memory supersede is not available in current REST adapter");
    }

    const normalizedMemoryId = memoryId.trim();
    if (normalizedMemoryId.length === 0) {
      throw new ValidationError("memoryId is required");
    }

    return this.rest.supersedeMemory(normalizedMemoryId, DEFAULT_REQUEST_OPTIONS);
  }

  public async archiveMemory(memoryId: string): Promise<ToolOperationResult> {
    assertCapability(this.capabilities, "memory");
    if (!this.rest.archiveMemory) {
      throw new UnsupportedFeatureError("Memory archive is not available in current REST adapter");
    }

    const normalizedMemoryId = memoryId.trim();
    if (normalizedMemoryId.length === 0) {
      throw new ValidationError("memoryId is required");
    }

    return this.rest.archiveMemory(normalizedMemoryId, DEFAULT_REQUEST_OPTIONS);
  }

  private resolveMentions(
    mentions: MentionInput,
  ): MentionReference[] {
    if (mentions.length === 0) {
      return [];
    }

    if (typeof mentions[0] !== "string") {
      return mentions
        .filter((entry): entry is MentionReference => typeof entry === "object" && entry !== null && "id" in entry)
        .map((entry) => ({ id: entry.id }));
    }

    const stringMentions = mentions.filter((entry): entry is string => typeof entry === "string");

    const participantsByHandle = new Map<string, MentionReference>();
    const participantsById = new Map<string, MentionReference>();
    const participantsByName = new Map<string, MentionReference>();
    for (const participant of this.participants) {
      const ref: MentionReference = { id: String(participant.id) };
      participantsById.set(ref.id, ref);
      const handle = participant.handle;
      if (typeof handle === "string") {
        participantsByHandle.set(this.normalizeMentionHandle(handle), ref);
      }
      const name = participant.name;
      if (typeof name === "string" && name.trim().length > 0) {
        participantsByName.set(name.trim().toLowerCase(), ref);
      }
    }

    return stringMentions.map((mention) => {
      // Try by ID first (UUID strings), then by handle, then by display name.
      const byId = participantsById.get(mention);
      if (byId) {
        return byId;
      }

      const normalized = this.normalizeMentionHandle(mention);
      const found = participantsByHandle.get(normalized);
      if (found) {
        return found;
      }

      const byName = participantsByName.get(mention.trim().toLowerCase());
      if (byName) {
        return byName;
      }

      throw new ValidationError(`Mention '${mention}' not found in participants`);
    });
  }

  private async lookupPeerByName(name: string): Promise<PeerRecord | null> {
    const target = name.trim().toLowerCase();
    const pageSize = 100;
    const maxPages = 25;

    for (let page = 1; page <= maxPages; page += 1) {
      const peers = await this.lookupPeers(page, pageSize);
      const items = peers.data ?? [];
      const match = items.find((peer) => String(peer.name ?? "").toLowerCase() === target);
      if (match) {
        return match;
      }

      const totalPages = peers.metadata?.totalPages;
      if (typeof totalPages === "number" && totalPages > 0 && page >= totalPages) {
        break;
      }

      if ((typeof totalPages !== "number" || totalPages <= 0) && items.length < pageSize) {
        break;
      }
    }

    return null;
  }

  private normalizeMentionHandle(handle: string): string {
    return handle.trim().replace(/^@+/, "").toLowerCase();
  }

  private replaceParticipants(participants: ParticipantRecord[]): void {
    this.participants.splice(0, this.participants.length, ...participants);
  }

  private buildAdapterTools(): AdapterToolsProtocol {
    const tools: Partial<AdapterToolsProtocol> = {
      capabilities: this.capabilities,
    };

    for (const methodName of REQUIRED_ADAPTER_TOOL_METHODS) {
      (tools as Record<string, unknown>)[methodName] = this.bindAdapterToolMethod(methodName);
    }

    for (const [capabilityKey, methodNames] of Object.entries(OPTIONAL_ADAPTER_TOOL_METHODS) as
      Array<[keyof AgentToolsCapabilities, readonly AdapterToolMethodName[]]>) {
      if (!this.capabilities[capabilityKey]) {
        continue;
      }
      for (const methodName of methodNames) {
        (tools as Record<string, unknown>)[methodName] = this.bindAdapterToolMethod(methodName);
      }
    }

    return Object.freeze(tools) as AdapterToolsProtocol;
  }

  private bindAdapterToolMethod<K extends AdapterToolMethodName>(methodName: K): AdapterToolsProtocol[K] {
    const method = this[methodName] as unknown as (...args: unknown[]) => unknown;
    return method.bind(this) as AdapterToolsProtocol[K];
  }

  private buildToolHandlers(): Record<string, ToolHandler> {
    return {
      ...this.buildMessagingToolHandlers(),
      ...this.buildContactToolHandlers(),
      ...this.buildMemoryToolHandlers(),
    };
  }

  private buildMessagingToolHandlers(): Record<string, ToolHandler> {
    return {
      thenvoi_send_message: async (arguments_) =>
        this.sendMessage(
          String(arguments_.content ?? ""),
          this.normalizeMentionInput(arguments_.mentions),
        ),
      thenvoi_send_event: async (arguments_) =>
        this.sendEvent(
          String(arguments_.content ?? ""),
          String(arguments_.message_type ?? "task"),
          this.normalizeOptionalMetadata(arguments_.metadata),
        ),
      thenvoi_add_participant: async (arguments_) =>
        this.addParticipant(String(arguments_.name ?? ""), String(arguments_.role ?? "member")),
      thenvoi_remove_participant: async (arguments_) =>
        this.removeParticipant(String(arguments_.name ?? "")),
      thenvoi_lookup_peers: async (arguments_) =>
        this.lookupPeers(
          coercePositiveInt(arguments_.page, 1),
          coercePositiveInt(arguments_.page_size, 50),
        ),
      thenvoi_get_participants: async () => this.getParticipants(),
      thenvoi_create_chatroom: async (arguments_) =>
        this.createChatroom(this.normalizeOptionalString(arguments_.task_id)),
    };
  }

  private buildContactToolHandlers(): Record<string, ToolHandler> {
    return {
      thenvoi_list_contacts: async (arguments_) =>
        this.listContacts({
          page: coercePositiveInt(arguments_.page, 1),
          pageSize: coercePositiveInt(arguments_.page_size, 50),
        }),
      thenvoi_add_contact: async (arguments_) =>
        this.addContact({
          handle: String(arguments_.handle ?? ""),
          ...(typeof arguments_.message === "string" ? { message: arguments_.message } : {}),
        }),
      thenvoi_remove_contact: async (arguments_) =>
        this.removeContact(this.toRemoveContactArgs(arguments_)),
      thenvoi_list_contact_requests: async (arguments_) =>
        this.listContactRequests({
          page: coercePositiveInt(arguments_.page, 1),
          pageSize: coercePositiveInt(arguments_.page_size, 50),
          sentStatus: String(arguments_.sent_status ?? "pending"),
        }),
      thenvoi_respond_contact_request: async (arguments_) =>
        this.respondContactRequest(this.toRespondContactRequestArgs(arguments_)),
    };
  }

  private buildMemoryToolHandlers(): Record<string, ToolHandler> {
    return {
      thenvoi_list_memories: async (arguments_) =>
        this.listMemories(this.toListMemoriesArgs(arguments_)),
      thenvoi_store_memory: async (arguments_) =>
        this.storeMemory(this.toStoreMemoryArgs(arguments_)),
      thenvoi_get_memory: async (arguments_) =>
        this.getMemory(String(arguments_.memory_id ?? "")),
      thenvoi_supersede_memory: async (arguments_) =>
        this.supersedeMemory(String(arguments_.memory_id ?? "")),
      thenvoi_archive_memory: async (arguments_) =>
        this.archiveMemory(String(arguments_.memory_id ?? "")),
    };
  }

  private toRemoveContactArgs(arguments_: MetadataMap): RemoveContactArgs {
    const handle = this.normalizeOptionalString(arguments_.handle);
    const contactId = this.normalizeOptionalString(arguments_.contact_id);
    if ((handle && contactId) || (!handle && !contactId)) {
      throw new ValidationError("Provide exactly one of handle or contact_id");
    }

    if (handle) {
      return {
        target: "handle",
        handle,
      };
    }

    // contactId is guaranteed non-undefined: the guard above throws when both are falsy.
    return {
      target: "contactId",
      contactId: contactId!,
    };
  }

  private toRespondContactRequestArgs(arguments_: MetadataMap): RespondContactRequestArgs {
    const actionValue = this.normalizeOptionalString(arguments_.action);
    if (!actionValue || !isContactRequestAction(actionValue)) {
      throw new ValidationError("action must be one of: approve, reject, cancel");
    }

    const handle = this.normalizeOptionalString(arguments_.handle);
    const requestId = this.normalizeOptionalString(arguments_.request_id);
    if ((handle && requestId) || (!handle && !requestId)) {
      throw new ValidationError("Provide exactly one of handle or request_id");
    }

    if (handle) {
      return {
        action: actionValue,
        target: "handle",
        handle,
      };
    }

    // requestId is guaranteed non-undefined: the guard above throws when both are falsy.
    return {
      action: actionValue,
      target: "requestId",
      requestId: requestId!,
    };
  }

  private toListMemoriesArgs(arguments_: MetadataMap): ListMemoriesArgs {
    const pageSize = this.normalizeOptionalNumber(arguments_.page_size);
    const scope = this.normalizeOptionalMemoryScope(arguments_.scope);
    const system = this.normalizeOptionalMemorySystem(arguments_.system);
    const type = this.normalizeOptionalMemoryType(arguments_.type);
    const segment = this.normalizeOptionalMemorySegment(arguments_.segment);
    const status = this.normalizeOptionalMemoryStatus(arguments_.status);
    const subjectId = this.normalizeOptionalString(arguments_.subject_id);
    const contentQuery = this.normalizeOptionalString(arguments_.content_query);

    return {
      ...(subjectId ? { subject_id: subjectId } : {}),
      ...(scope ? { scope } : {}),
      ...(system ? { system } : {}),
      ...(type ? { type } : {}),
      ...(segment ? { segment } : {}),
      ...(contentQuery ? { content_query: contentQuery } : {}),
      ...(typeof pageSize === "number" ? { page_size: pageSize } : {}),
      ...(status ? { status } : {}),
    };
  }

  private toStoreMemoryArgs(arguments_: MetadataMap): StoreMemoryArgs {
    const content = this.normalizeRequiredString(arguments_.content, "content");
    const thought = this.normalizeRequiredString(arguments_.thought, "thought");
    const system = this.normalizeOptionalMemorySystem(arguments_.system);
    const type = this.normalizeOptionalMemoryType(arguments_.type);
    const segment = this.normalizeOptionalMemorySegment(arguments_.segment);
    const scope = this.normalizeOptionalStoreMemoryScope(arguments_.scope);
    const subjectId = this.normalizeOptionalString(arguments_.subject_id);
    const metadata = this.normalizeOptionalMetadata(arguments_.metadata);

    if (!system) {
      throw new ValidationError("system must be one of: sensory, working, long_term");
    }

    if (!type) {
      throw new ValidationError("type must be one of: iconic, echoic, haptic, episodic, semantic, procedural");
    }

    if (!segment) {
      throw new ValidationError("segment must be one of: user, agent, tool, guideline");
    }

    return {
      content,
      thought,
      system,
      type,
      segment,
      ...(scope ? { scope } : {}),
      ...(subjectId ? { subject_id: subjectId } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeRequiredString(value: unknown, fieldName: string): string {
    const normalized = this.normalizeOptionalString(value);
    if (!normalized) {
      throw new ValidationError(`${fieldName} is required`);
    }

    return normalized;
  }

  private normalizeOptionalNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  private normalizeOptionalMetadata(value: unknown): MetadataMap | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }

    return value as MetadataMap;
  }

  private normalizeMentionInput(value: unknown): MentionInput {
    if (!Array.isArray(value) || value.length === 0) {
      return [];
    }

    if (typeof value[0] === "string") {
      return value.filter((entry): entry is string => typeof entry === "string");
    }

    const mentions: MentionReference[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }

      const mention = entry as Record<string, unknown>;
      if (typeof mention.id !== "string") {
        continue;
      }

      mentions.push({ id: mention.id });
    }

    return mentions;
  }

  private normalizeOptionalMemoryScope(value: unknown): MemoryScope | undefined {
    const normalized = this.normalizeOptionalString(value);
    if (!normalized) {
      return undefined;
    }

    if (!isListMemoryScope(normalized)) {
      throw new ValidationError("scope must be one of: subject, organization, all");
    }

    return normalized;
  }

  private normalizeOptionalMemorySystem(value: unknown): MemorySystem | undefined {
    const normalized = this.normalizeOptionalString(value);
    if (!normalized) {
      return undefined;
    }

    if (!isMemorySystem(normalized)) {
      throw new ValidationError("system must be one of: sensory, working, long_term");
    }

    return normalized;
  }

  private normalizeOptionalMemoryType(value: unknown): MemoryType | undefined {
    const normalized = this.normalizeOptionalString(value);
    if (!normalized) {
      return undefined;
    }

    if (!isMemoryType(normalized)) {
      throw new ValidationError("type must be one of: iconic, echoic, haptic, episodic, semantic, procedural");
    }

    return normalized;
  }

  private normalizeOptionalMemorySegment(value: unknown): MemorySegment | undefined {
    const normalized = this.normalizeOptionalString(value);
    if (!normalized) {
      return undefined;
    }

    if (!isMemorySegment(normalized)) {
      throw new ValidationError("segment must be one of: user, agent, tool, guideline");
    }

    return normalized;
  }

  private normalizeOptionalMemoryStatus(value: unknown): MemoryStatus | undefined {
    const normalized = this.normalizeOptionalString(value);
    if (!normalized) {
      return undefined;
    }

    if (!isMemoryStatus(normalized)) {
      throw new ValidationError("status must be one of: active, superseded, archived, all");
    }

    return normalized;
  }

  private normalizeOptionalStoreMemoryScope(
    value: unknown,
  ): NonNullable<StoreMemoryArgs["scope"]> | undefined {
    const normalized = this.normalizeOptionalString(value);
    if (!normalized) {
      return undefined;
    }

    if (!isStoreMemoryScope(normalized)) {
      throw new ValidationError("scope must be one of: subject, organization");
    }

    return normalized;
  }
}

function isContactRequestAction(value: string): value is RespondContactRequestArgs["action"] {
  return CONTACT_REQUEST_ACTIONS.has(value as RespondContactRequestArgs["action"]);
}

function isMemorySystem(value: string): value is MemorySystem {
  return MEMORY_SYSTEMS.has(value as MemorySystem);
}

function isMemoryType(value: string): value is MemoryType {
  return MEMORY_TYPES.has(value as MemoryType);
}

function isMemorySegment(value: string): value is MemorySegment {
  return MEMORY_SEGMENTS.has(value as MemorySegment);
}

function isStoreMemoryScope(value: string): value is NonNullable<StoreMemoryArgs["scope"]> {
  return MEMORY_SCOPES.has(value as NonNullable<StoreMemoryArgs["scope"]>);
}

function isListMemoryScope(value: string): value is MemoryScope {
  return LIST_MEMORY_SCOPES.has(value as MemoryScope);
}

function isMemoryStatus(value: string): value is MemoryStatus {
  return LIST_MEMORY_STATUSES.has(value as MemoryStatus);
}

function coercePositiveInt(value: unknown, fallback: number): number {
  const num = Number(value ?? fallback);
  return Number.isFinite(num) && num >= 1 ? Math.floor(num) : fallback;
}

/**
 * Validate tool arguments before execution.
 * Returns a normalized tool executor error if validation fails, or null if valid.
 */
function validateToolArgs(toolName: string, args: Record<string, unknown>): ToolExecutorError | null {
  const errors: string[] = [];

  const model = TOOL_MODELS[toolName as keyof typeof TOOL_MODELS];
  if (!model) {
    return null;
  }

  for (const field of model.required) {
    if (args[field] === undefined || args[field] === null) {
      errors.push(`${field}: Field required`);
    }
  }

  if (toolName === "thenvoi_send_message") {
    const mentions = args.mentions;
    if (Array.isArray(mentions) && mentions.length === 0) {
      errors.push("mentions: At least one mention is required");
    }
  }

  if (toolName === "thenvoi_send_event") {
    const messageType = args.message_type;
    if (typeof messageType === "string" && !(CHAT_EVENT_TYPES as readonly string[]).includes(messageType)) {
      errors.push(
        `message_type: Invalid value '${messageType}'. Expected one of: ${[...CHAT_EVENT_TYPES].join(", ")}`,
      );
    }
  }

  if (toolName === "thenvoi_respond_contact_request") {
    const action = args.action;
    const validActions = ["approve", "reject", "cancel"];
    if (typeof action === "string" && !validActions.includes(action)) {
      errors.push(
        `action: Invalid value '${action}'. Expected one of: ${validActions.join(", ")}`,
      );
    }
  }

  if (toolName === "thenvoi_store_memory") {
    const validSystems = ["sensory", "working", "long_term"];
    const validTypes = ["iconic", "echoic", "haptic", "episodic", "semantic", "procedural"];
    const validSegments = ["user", "agent", "tool", "guideline"];

    if (typeof args.system === "string" && !validSystems.includes(args.system)) {
      errors.push(`system: Invalid value '${args.system}'. Expected one of: ${validSystems.join(", ")}`);
    }
    if (typeof args.type === "string" && !validTypes.includes(args.type)) {
      errors.push(`type: Invalid value '${args.type}'. Expected one of: ${validTypes.join(", ")}`);
    }
    if (typeof args.segment === "string" && !validSegments.includes(args.segment)) {
      errors.push(`segment: Invalid value '${args.segment}'. Expected one of: ${validSegments.join(", ")}`);
    }
  }

  if (errors.length > 0) {
    const message = `Invalid arguments for ${toolName}: ${errors.join("; ")}`;
    return createToolExecutorError({
      errorType: "ToolArgumentsValidationError",
      toolName,
      message,
      legacyMessage: message,
      details: { validationErrors: errors },
    });
  }

  return null;
}
