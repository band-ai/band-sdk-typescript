export { SimpleAdapter } from "./simpleAdapter";
export type {
  FrameworkAdapter,
  FrameworkAdapterInput,
  Preprocessor,
  HistoryConverter,
  MessagingTools,
  RoomParticipantTools,
  PeerLookupTools,
  ParticipantTools,
  ToolSchemaProvider,
  ContactTools,
  MemoryTools,
  ToolExecutor,
  AdapterToolsProtocol,
  AgentToolsProtocol,
} from "../contracts/protocols";
export {
  BandSdkError,
  UnsupportedFeatureError,
  ValidationError,
  TransportError,
  RuntimeStateError,
  asErrorMessage,
  serializeError,
} from "./errors";
export { WebSocketDisconnectError } from "../platform/streaming/disconnectReason";
export type {
  WebSocketConflictPolicy,
  WebSocketDisconnectReason,
} from "../platform/streaming/disconnectReason";
export { ConsoleLogger, NoopLogger, type Logger } from "./logger";

// DTO types referenced by AdapterToolsProtocol's own method signatures. Without these a
// custom-adapter author cannot name the arguments or results of the protocol they are
// implementing without reaching into an internal path.
export type {
  MetadataMap,
  MentionInput,
  MentionReference,
  ToolOperationResult,
  PaginatedList,
  PaginationMetadataLike,
  ParticipantRecord,
  PeerRecord,
  ContactRecord,
  MemoryRecord,
  ToolSchemaRecord,
  ListContactsArgs,
  AddContactArgs,
  RemoveContactArgs,
  ListContactRequestsArgs,
  RespondContactRequestArgs,
  ContactRequestsResult,
  ListMemoriesArgs,
  StoreMemoryArgs,
} from "../contracts/dtos";

// The memory contract. Constants and guards are values, not types: callers validate
// user-supplied strings against them at runtime.
export {
  MEMORY_SYSTEMS,
  MEMORY_TYPES,
  MEMORY_SEGMENTS,
  MEMORY_STORE_SCOPES,
  MEMORY_LIST_SCOPES,
  MEMORY_STATUSES,
  MEMORY_SYSTEM,
  MEMORY_TYPE,
  MEMORY_SEGMENT,
  MEMORY_STORE_SCOPE,
  isMemorySystem,
  isMemoryType,
  isMemoryTypeForSystem,
  isMemorySegment,
  isMemoryStoreScope,
  isMemoryListScope,
  isMemoryStatus,
} from "../contracts/memory";
export type {
  MemorySystem,
  MemoryType,
  MemorySegment,
  MemoryStoreScope,
  MemoryScope,
  MemoryStatus,
  MemoryVisibility,
} from "../contracts/memory";

export { DEFAULT_AGENT_TOOLS_CAPABILITIES } from "../contracts/protocols";
export type { AgentToolsCapabilities } from "../contracts/protocols";

// Types and helpers needed to implement FrameworkAdapter.onEvent without importing from
// an internal contracts path.
export {
  TOOL_EXECUTOR_ERROR_TYPES,
  createToolExecutorError,
  isToolExecutorError,
  toLegacyToolExecutorErrorMessage,
} from "../contracts/protocols";
export type {
  PlatformMessageLike,
  HistoryLike,
  PreprocessorContext,
  EventEnvelope,
  ToolExecutorError,
  ToolExecutorErrorType,
} from "../contracts/protocols";
