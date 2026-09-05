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

export interface HistoryConverter<T> {
  convert(raw: MetadataMap[]): T;
}

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

export interface HistoryLike {
  readonly raw: MetadataMap[];
  convert<T>(converter: HistoryConverter<T>): T;
  readonly length: number;
}

export interface MessagingTools {
  sendMessage(
    content: string,
    mentions?: MentionInput,
  ): Promise<ToolOperationResult>;
  sendEvent(
    content: string,
    messageType: string,
    metadata?: MetadataMap,
  ): Promise<ToolOperationResult>;
}

export interface RoomParticipantTools {
  addParticipant(name: string, role?: string): Promise<ToolOperationResult>;
  removeParticipant(name: string): Promise<ToolOperationResult>;
  getParticipants(): Promise<ParticipantRecord[]>;
  createChatroom(taskId?: string): Promise<string>;
}

export interface PeerLookupTools {
  lookupPeers(page?: number, pageSize?: number): Promise<PaginatedList<PeerRecord>>;
}

export interface ToolSchemaProvider {
  getToolSchemas(
    format: "openai" | "anthropic",
    options?: { includeMemory?: boolean },
  ): ToolSchemaRecord[];
  getAnthropicToolSchemas(options?: { includeMemory?: boolean }): ToolSchemaRecord[];
  getOpenAIToolSchemas(options?: { includeMemory?: boolean }): ToolSchemaRecord[];
}

export interface ContactTools {
  listContacts(request?: ListContactsArgs): Promise<PaginatedList<ContactRecord>>;
  addContact(request: AddContactArgs): Promise<ToolOperationResult>;
  removeContact(request: RemoveContactArgs): Promise<ToolOperationResult>;
  listContactRequests(
    request?: ListContactRequestsArgs,
  ): Promise<ContactRequestsResult>;
  respondContactRequest(request: RespondContactRequestArgs): Promise<ToolOperationResult>;
}

export interface MemoryTools {
  listMemories(args?: ListMemoriesArgs): Promise<PaginatedList<MemoryRecord>>;
  storeMemory(args: StoreMemoryArgs): Promise<MemoryRecord>;
  getMemory(memoryId: string): Promise<MemoryRecord>;
  supersedeMemory(memoryId: string): Promise<ToolOperationResult>;
  archiveMemory(memoryId: string): Promise<ToolOperationResult>;
}

export interface ToolExecutor {
  executeToolCall(toolName: string, toolArgs: MetadataMap): Promise<unknown>;
}

export const TOOL_EXECUTOR_ERROR_TYPES = [
  "ToolArgumentsValidationError",
  "ToolNotFoundError",
  "ToolExecutionError",
] as const;

export type ToolExecutorErrorType = (typeof TOOL_EXECUTOR_ERROR_TYPES)[number];

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

/** An `{ok:false}` result carrying a human-readable `message`, not yet shaped as a `ToolExecutorError`. */
export function isStructuredToolFailure(value: unknown): value is { ok: false; message: string } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Record<string, unknown>;
  return payload.ok === false && typeof payload.message === "string";
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

export type AgentToolsProtocol = AdapterToolsProtocol;

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

export interface FrameworkAdapterInput {
  message: PlatformMessageLike;
  tools: AdapterToolsProtocol;
  history: HistoryLike;
  participantsMessage: string | null;
  contactsMessage: string | null;
  isSessionBootstrap: boolean;
  roomId: string;
}

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

export interface EventEnvelope {
  type: string;
  roomId: string | null;
  payload: MetadataMap;
  raw?: MetadataMap;
}

export interface Preprocessor<TEvent extends EventEnvelope = EventEnvelope> {
  process(
    context: PreprocessorContext,
    event: TEvent,
    agentId: string,
  ): Promise<FrameworkAdapterInput | null>;
}
