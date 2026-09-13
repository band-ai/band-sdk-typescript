export type {
  AgentConfig,
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
  SYNTHETIC_SENDER_TYPE,
  SYNTHETIC_CONTACT_EVENTS_SENDER_ID,
  SYNTHETIC_CONTACT_EVENTS_SENDER_NAME,
  ensureHandlePrefix,
} from "./types";

export { ContactEventHandler, HUB_ROOM_SYSTEM_PROMPT } from "./ContactEventHandler";
export type { ExecutionState, ExecutionContextOptions } from "./ExecutionContext";
export type { ExecutionHandler } from "./Execution";

export { AgentRuntime } from "./rooms/AgentRuntime";
export { Execution } from "./Execution";
export { ExecutionContext } from "./ExecutionContext";
export { PlatformRuntime } from "./PlatformRuntime";
export { RoomPresence } from "./rooms/RoomPresence";

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
  CONTACT_TOOL_NAMES,
  ALL_TOOL_NAMES,
  BASE_TOOL_NAMES,
  mcpToolNames,
  getToolDescription,
} from "./tools/schemas";
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
} from "./formatters";

export {
  BASE_INSTRUCTIONS,
  MEMORY_SECTION,
  TEMPLATES,
  renderSystemPrompt,
  type RenderSystemPromptOptions,
} from "./prompts";

export { GracefulShutdown, runWithGracefulShutdown } from "./shutdown";
export { DefaultPreprocessor } from "./preprocessing/DefaultPreprocessor";
