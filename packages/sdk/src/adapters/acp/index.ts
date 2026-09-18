export {
  ACPClientAdapter,
  createTcpConnection,
  type ACPClientAdapterOptions,
  type ACPClientAdapterBaseOptions,
  type ACPClientStdioOptions,
  type ACPClientTcpOptions,
  type ACPConfigRequest,
  type ACPConfigSelections,
} from "./ACPClientAdapter";

export {
  ACPServer,
  type ACPServerOptions,
} from "./ACPServer";

export {
  BandACPServerAdapter,
  type BandACPServerAdapterOptions,
} from "./BandACPServerAdapter";

export type {
  ACPPermissionAbandonReason,
  ACPPermissionEndReason,
  ACPPermissionRequest,
  ACPClientTcpEndpoint,
} from "./types";

export type { ACPExtensionHandler } from "./extensions";
export { CursorExtensionHandler } from "./cursorExtensions";

export {
  AcpSessionConfigError,
  FAILURE_CODE_SESSION_CONFIG,
  MISSING_CONFIG_OPTIONS_REASON,
  applySessionConfigSelections,
  type ApplySessionConfigSelectionsInput,
  type ApplySessionConfigSelectionsResult,
} from "./sessionConfigReconciliation";
