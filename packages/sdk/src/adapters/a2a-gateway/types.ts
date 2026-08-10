import type { RestApi } from "../../client/rest/types";

export type GatewayTaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown";

export interface GatewayMessagePart {
  kind?: string;
  text?: string;
  root?: {
    text?: string;
  };
}

export interface GatewayA2AMessage {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: GatewayMessagePart[];
  contextId?: string;
  taskId?: string;
}

export interface GatewayA2ATaskStatus {
  state: GatewayTaskState;
  timestamp?: string;
  message?: GatewayA2AMessage;
}

export interface GatewayA2AStatusUpdateEvent {
  kind: "status-update";
  taskId: string;
  contextId: string;
  final: boolean;
  status: GatewayA2ATaskStatus;
  metadata?: Record<string, unknown>;
}

export interface GatewayRequest {
  /**
   * Canonical Band peer id.
   * Legacy clients may still send a slug in this field; adapter-side normalization handles that alias.
   */
  peerId: string;
  /**
   * Optional gateway route slug for compatibility/diagnostics.
   */
  peerSlug?: string;
  taskId: string;
  contextId: string;
  message: GatewayA2AMessage;
}

export interface GatewayCancelRequest {
  /**
   * Canonical Band peer id.
   * Legacy clients may still send a slug in this field; adapter-side normalization handles that alias.
   */
  peerId: string;
  /**
   * Optional gateway route slug for compatibility/diagnostics.
   */
  peerSlug?: string;
  taskId: string;
}

export interface GatewayPeer {
  id: string;
  name: string;
  description: string;
  handle?: string | null;
  slug: string;
}

export interface GatewaySessionState {
  contextToRoom: Record<string, string>;
  roomParticipants: Record<string, string[]>;
}

export interface PendingA2ATask {
  taskId: string;
  contextId: string;
  peerId: string;
  peerSlug?: string;
  roomId: string;
  enqueue(event: GatewayA2AStatusUpdateEvent): void;
}

export interface GatewayServerLike {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface GatewayServerOptions {
  peersBySlug: Map<string, GatewayPeer>;
  peersById: Map<string, GatewayPeer>;
  gatewayUrl: string;
  host: string;
  port: number;
  authToken?: string;
  allowUnauthenticatedLoopback?: boolean;
  onRequest: (
    request: GatewayRequest,
  ) => AsyncIterable<GatewayA2AStatusUpdateEvent>;
  onCancel?: (request: GatewayCancelRequest) => Promise<void>;
  loadModules?: () => Promise<unknown>;
}

export type GatewayServerFactory = (
  options: GatewayServerOptions,
) => GatewayServerLike;

export interface A2AGatewayAdapterOptions {
  thenvoiRest: RestApi;
  gatewayUrl?: string;
  host?: string;
  port?: number;
  authToken?: string;
  allowUnauthenticatedLoopback?: boolean;
  responseTimeoutMs?: number;
  peerPageSize?: number;
  maxPeerPages?: number;
  serverFactory?: GatewayServerFactory;
}
