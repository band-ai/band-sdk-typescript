import type {
  AddContactArgs,
  ContactRequestsResult,
  ContactRecord,
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
} from "./dtos";

/** Turns a room's raw message history into a framework's own message representation. */
export interface HistoryConverter<T> {
  convert(raw: MetadataMap[]): T;
}

/** One chat message as it arrives from the platform, normalized to the SDK's field names. */
export interface PlatformMessageLike {
  id: string;
  roomId: string;
  content: string;
  senderId: string;
  senderType: string;
  senderName: string | null;
  messageType: string;
  metadata: MetadataMap;
  createdAt: Date;
}

/** Read-only view of a room's raw history, convertible via a {@link HistoryConverter}. */
export interface HistoryLike {
  readonly raw: MetadataMap[];
  convert<T>(converter: HistoryConverter<T>): T;
  readonly length: number;
}

/**
 * Sending side of the chat surface: post a message, or post a non-message room event such
 * as a thought or an error.
 */
export interface MessagingTools {
  /**
   * Posts a chat message to the room.
   *
   * A message must address at least one participant. The `band_send_message` tool rejects
   * a call whose `mentions` list is empty, and a message that mentions nobody reaches
   * nobody, so pass at least one handle here too. Use {@link sendEvent} for output that is
   * not directed at anyone.
   */
  sendMessage(
    content: string,
    mentions?: MentionInput,
  ): Promise<ToolOperationResult>;
  /**
   * Posts a non-message room event (`thought`, `error`, `task`, …). Unlike
   * {@link sendMessage} it needs no mention, so it is the right call for progress updates.
   */
  sendEvent(
    content: string,
    messageType: string,
    metadata?: MetadataMap,
  ): Promise<ToolOperationResult>;
}

/** Room membership surface: add, remove and list participants, and create new rooms. */
export interface RoomParticipantTools {
  addParticipant(name: string, role?: string): Promise<ToolOperationResult>;
  removeParticipant(name: string): Promise<ToolOperationResult>;
  getParticipants(): Promise<ParticipantRecord[]>;
  createChatroom(taskId?: string): Promise<string>;
}

/** Directory surface: page through the agents and users this agent may add to a room. */
export interface PeerLookupTools {
  lookupPeers(page?: number, pageSize?: number): Promise<PaginatedList<PeerRecord>>;
}

/** Renders the platform tool set as function/tool schemas in a model provider's format. */
export interface ToolSchemaProvider {
  getToolSchemas(
    format: "openai" | "anthropic",
    options?: { includeMemory?: boolean },
  ): ToolSchemaRecord[];
  getAnthropicToolSchemas(options?: { includeMemory?: boolean }): ToolSchemaRecord[];
  getOpenAIToolSchemas(options?: { includeMemory?: boolean }): ToolSchemaRecord[];
}

/** Contact surface: list contacts, request and remove them, and answer incoming requests. */
export interface ContactTools {
  listContacts(request?: ListContactsArgs): Promise<PaginatedList<ContactRecord>>;
  addContact(request: AddContactArgs): Promise<ToolOperationResult>;
  removeContact(request: RemoveContactArgs): Promise<ToolOperationResult>;
  listContactRequests(
    request?: ListContactRequestsArgs,
  ): Promise<ContactRequestsResult>;
  respondContactRequest(request: RespondContactRequestArgs): Promise<ToolOperationResult>;
}

/** Memory surface: query, store, retrieve, supersede and archive the agent's memories. */
export interface MemoryTools {
  listMemories(args?: ListMemoriesArgs): Promise<PaginatedList<MemoryRecord>>;
  storeMemory(args: StoreMemoryArgs): Promise<MemoryRecord>;
  getMemory(memoryId: string): Promise<MemoryRecord>;
  supersedeMemory(memoryId: string): Promise<ToolOperationResult>;
  archiveMemory(memoryId: string): Promise<ToolOperationResult>;
}

/** Dispatch surface: run a platform tool by name with the arguments a model produced. */
export interface ToolExecutor {
  executeToolCall(toolName: string, toolArgs: MetadataMap): Promise<unknown>;
}

export const TOOL_EXECUTOR_ERROR_TYPES = [
  "ToolArgumentsValidationError",
  "ToolNotFoundError",
  "ToolExecutionError",
] as const;

/** Which stage of a tool call failed: argument validation, lookup, or execution. */
export type ToolExecutorErrorType = (typeof TOOL_EXECUTOR_ERROR_TYPES)[number];

/** Structured failure returned (not thrown) by {@link ToolExecutor.executeToolCall}. */
export interface ToolExecutorError {
  ok: false;
  errorType: ToolExecutorErrorType;
  toolName: string;
  message: string;
  /**
   * Backward-compatible plain text rendering used by older adapter paths that
   * still expect string errors.
   */
  legacyMessage: string;
  details?: MetadataMap;
}

export function createToolExecutorError(input: {
  errorType: ToolExecutorErrorType;
  toolName: string;
  message: string;
  legacyMessage?: string;
  details?: MetadataMap;
}): ToolExecutorError {
  return {
    ok: false,
    errorType: input.errorType,
    toolName: input.toolName,
    message: input.message,
    legacyMessage: input.legacyMessage ?? input.message,
    ...(input.details ? { details: input.details } : {}),
  };
}

export function isToolExecutorError(value: unknown): value is ToolExecutorError {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.ok === false
    && typeof candidate.errorType === "string"
    && (TOOL_EXECUTOR_ERROR_TYPES as readonly string[]).includes(candidate.errorType)
    && typeof candidate.toolName === "string"
    && typeof candidate.message === "string"
    && typeof candidate.legacyMessage === "string"
  );
}

export function toLegacyToolExecutorErrorMessage(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (!isToolExecutorError(value)) {
    return null;
  }

  return value.legacyMessage;
}

/** Room membership and peer lookup together, for adapters that need both. */
export interface ParticipantTools extends RoomParticipantTools, PeerLookupTools {}

/** Full tool surface available to framework adapters during message handling. */
export interface AdapterToolsProtocol
  extends
    MessagingTools,
    RoomParticipantTools,
    ToolSchemaProvider,
    ToolExecutor,
    Partial<PeerLookupTools>,
    Partial<ContactTools>,
    Partial<MemoryTools> {
  /** Check capability flags to determine which optional tools are available. */
  readonly capabilities: Readonly<AgentToolsCapabilities>;
}

/** Alias of {@link AdapterToolsProtocol}, kept for adapters that already import this name. */
export type AgentToolsProtocol = AdapterToolsProtocol;

/** Which optional tool groups the current tool instance actually supports. */
export interface AgentToolsCapabilities {
  peers: boolean;
  contacts: boolean;
  memory: boolean;
}

export const DEFAULT_AGENT_TOOLS_CAPABILITIES: AgentToolsCapabilities = {
  peers: true,
  contacts: true,
  memory: true,
};

/** Everything an adapter receives for one turn: the message, its room context, and the tools. */
export interface FrameworkAdapterInput {
  message: PlatformMessageLike;
  tools: AdapterToolsProtocol;
  history: HistoryLike;
  participantsMessage: string | null;
  contactsMessage: string | null;
  isSessionBootstrap: boolean;
  roomId: string;
}

/**
 * Per-room state a {@link Preprocessor} reads and mutates while deciding whether an event
 * becomes an adapter turn — dedupe bookkeeping, history hydration, and pending system
 * messages.
 */
export interface PreprocessorContext {
  roomId: string;
  hasMessage(messageId: string): boolean;
  recordMessage(message: PlatformMessageLike): void;
  getTools(): AdapterToolsProtocol;
  getRawHistory(): MetadataMap[];
  getHydratedHistory(excludeMessageId?: string): Promise<MetadataMap[]>;
  consumeParticipantsMessage(): string | null;
  consumeContactsMessage(): string | null;
  readonly isLlmInitialized: boolean;
  markLlmInitialized(): void;
  injectSystemMessage(message: string): void;
  consumeSystemMessages(): string[];
}

/** Contract that every adapter must satisfy. Implement via {@link SimpleAdapter} for convenience. */
export interface FrameworkAdapter {
  onEvent(input: FrameworkAdapterInput): Promise<void>;
  onCleanup(roomId: string): Promise<void>;
  onStarted(agentName: string, agentDescription: string): Promise<void>;
  onRuntimeStop?(): Promise<void>;
}

/** Minimal shape of a platform event: its type, the room it belongs to, and its payload. */
export interface EventEnvelope {
  type: string;
  roomId: string | null;
  payload: MetadataMap;
  raw?: MetadataMap;
}

/**
 * Decides what a platform event means for a room: returns the adapter input to run, or
 * `null` to drop the event.
 */
export interface Preprocessor<TEvent extends EventEnvelope = EventEnvelope> {
  process(
    context: PreprocessorContext,
    event: TEvent,
    agentId: string,
  ): Promise<FrameworkAdapterInput | null>;
}
