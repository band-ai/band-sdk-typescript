export { SimpleAdapter } from "./simpleAdapter";
// `MessagingTools.sendFailure` is typed by this; a consumer implementing a
// custom `MessagingTools`/adapter cannot import a transitive dependency.
export { AgentFailure } from "@band-ai/band-sdk-core";
// The wire contract behind that required `sendFailure`. Without these, a
// consumer implementing `MessagingTools` has to re-derive the event type, the
// metadata key, and the blank-message fallback that keeps a failure from
// vanishing when the platform rejects an empty body.
export {
  FAILURE_EVENT_TYPE,
  FAILURE_METADATA_KEY,
  toFailureEvent,
} from "../contracts/protocols";
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
  RecoverableTurnError,
} from "./errors";
export { WebSocketDisconnectError } from "../platform/streaming/disconnectReason";
export type {
  WebSocketConflictPolicy,
  WebSocketDisconnectReason,
} from "../platform/streaming/disconnectReason";
export { ConsoleLogger, NoopLogger, type Logger } from "./logger";
