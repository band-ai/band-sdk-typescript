export type {
  AgentConfig,
  ResolvedSessionConfig,
  SessionConfig,
  PlatformMessage,
  ConversationContext,
  MessageHandler,
  ContactEventConfig,
  ContactEventStrategy,
  ContactEventCallback,
} from "./types";
export {
  HistoryProvider,
  MAX_MESSAGE_RETRIES,
  DEFAULT_CONTEXT_CACHE_TTL_SECONDS,
  MIN_CONTEXT_MESSAGES,
  MAX_CONTEXT_MESSAGES,
  DEFAULT_MAX_MESSAGE_RETRIES,
  parseSessionConfig,
  sessionConfigSchema,
  SYNTHETIC_SENDER_TYPE,
  SYNTHETIC_CONTACT_EVENTS_SENDER_ID,
  SYNTHETIC_CONTACT_EVENTS_SENDER_NAME,
  ensureHandlePrefix,
} from "./types";

export { ContactEventHandler, HUB_ROOM_SYSTEM_PROMPT } from "./ContactEventHandler";
export type { ExecutionState, ExecutionContextOptions } from "./ExecutionContext";
export type { ExecutionHandler } from "./Execution";
export type { RuntimeLifecycleState, ExecutionLifecycleState } from "./lifecycle";

export { AgentRuntime } from "./rooms/AgentRuntime";
export { Execution } from "./Execution";
export { ExecutionContext } from "./ExecutionContext";
export { PlatformRuntime } from "./PlatformRuntime";
export { RoomPresence } from "./rooms/RoomPresence";

// The runtime's turn journal layer: the identity-bound room journals a start
// generation opens, one owner of a journal at a time, and the publication
// engine that settles a reply before its caller sees it. A host that embeds
// the runtime can open and drive a journal directly, or open one read-only to
// see what a stopped process settled.
export {
  TurnJournal,
  agentJournalDir,
  legacyAgentDir,
  roomFileName,
  roomJournalFile,
  type JournalGeneration,
  type TurnJournalOptions,
} from "./journal/TurnJournal";
export { RoomJournal, type RoomJournalOptions, type UnresolvedPublication } from "./journal/RoomJournal";
export { PublicationEngine } from "./journal/publication";
export { JournalOwnership } from "./journal/ownership";
export { canonicalPlatformIdentity } from "./journal/identity";

export { AgentTools } from "./tools/AgentTools";
export { ContactToolsImpl } from "./tools/ContactToolsImpl";

// `AgentTools`'s `roster` option, `ExecutionContext.getRetryTracker()`, and
// `AgentRuntime.presence.roster` are typed by these, and a consumer cannot
// import a transitive dependency.
export { ParticipantRoster, RetryTracker, RoomRoster } from "@band-ai/band-sdk-core";
export type { RoomMembership } from "@band-ai/band-sdk-core";
export {
  TOOL_MODELS,
  MCP_TOOL_PREFIX,
  MCP_SERVER_NAME,
  CHAT_TOOL_NAMES,
  MEMORY_TOOL_NAMES,
  TASK_TOOL_NAMES,
  CONTACT_TOOL_NAMES,
  ROOM_TOOL_NAMES,
  ALL_TOOL_NAMES,
  BASE_TOOL_NAMES,
  mcpToolNames,
  getToolDescription,
} from "../contracts/toolSchemas";
export {
  CHAT_EVENT_TYPES,
  CHAT_MESSAGE_TYPES,
  isChatEventType,
  assertChatEventType,
  type ChatEventType,
  type ChatMessageType,
} from "./messages";

export {
  replaceUuidMentions,
  mentionSubjectsFromMetadata,
  formatMessageForLlm,
  formatHistoryForLlm,
  buildParticipantsMessage,
  commandWords,
} from "./formatters";

export {
  BASE_INSTRUCTIONS,
  MEMORY_SECTION,
  TEMPLATES,
  renderSystemPrompt,
  withMemoryGuidance,
  type RenderSystemPromptOptions,
} from "./prompts";

export { GracefulShutdown, runWithGracefulShutdown } from "./shutdown";
export { DefaultPreprocessor } from "./preprocessing/DefaultPreprocessor";

export { supportsCapability } from "../contracts/capabilities";
