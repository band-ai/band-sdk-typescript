import type { LinearClient } from "@linear/sdk";
import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";

import type { RestApi } from "../../client/rest/types";
import type { Logger } from "../../core/logger";

export type RoomStrategy = "issue" | "session";
export type WritebackMode = "final_only" | "activity_stream";
export type SessionStatus = "active" | "waiting" | "completed" | "canceled" | "errored";

/** Default interval (ms) between stale-session keepalive checks. */
export const STALE_SESSION_CHECK_INTERVAL_MS = 20 * 60_000;

/**
 * Maximum age (ms) of the last Linear activity before a session is considered
 * at risk of going stale. Linear marks sessions stale after 30 minutes of
 * inactivity; we send a keepalive well before that threshold.
 */
export const STALE_SESSION_THRESHOLD_MS = 25 * 60_000;

export interface LinearThenvoiBridgeConfig {
  linearAccessToken: string;
  linearWebhookSecret: string;
  roomStrategy?: RoomStrategy;
  writebackMode?: WritebackMode;
  hostAgentHandle?: string;
  planningAgentHandles?: string[];
  implementationAgentHandles?: string[];
  recoveredRoomRetryBaseDelayMs?: number;
  thenvoiAppBaseUrl?: string;
}

export interface SessionRoomRecord {
  linearSessionId: string;
  linearIssueId: string | null;
  thenvoiRoomId: string;
  status: SessionStatus;
  lastEventKey?: string | null;
  /** ISO-8601 timestamp of the last activity sent to Linear for this session. */
  lastLinearActivityAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingBootstrapRequest {
  eventKey: string;
  linearSessionId: string;
  thenvoiRoomId: string;
  expectedContent: string;
  messageType: string;
  senderId?: string | null;
  senderName?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export interface SessionRoomStore {
  getBySessionId(sessionId: string): Promise<SessionRoomRecord | null>;
  getByIssueId(issueId: string): Promise<SessionRoomRecord | null>;
  upsert(record: SessionRoomRecord): Promise<void>;
  markCanceled(sessionId: string): Promise<void>;
  enqueueBootstrapRequest(request: PendingBootstrapRequest): Promise<void>;
  listPendingBootstrapRequests(limit?: number): Promise<PendingBootstrapRequest[]>;
  markBootstrapRequestProcessed(eventKey: string): Promise<void>;
  /** List sessions with active or waiting status (used by stale-session keepalive). */
  listActiveSessions?(): Promise<SessionRoomRecord[]>;
  close?(): Promise<void>;
}

export interface LinearThenvoiBridgeDeps {
  thenvoiRest: RestApi;
  linearClient: LinearClient;
  store: SessionRoomStore;
  logger?: Logger;
}

export interface HandleAgentSessionEventInput {
  payload: AgentSessionEventWebhookPayload;
  config: LinearThenvoiBridgeConfig;
  deps: LinearThenvoiBridgeDeps;
}

export type { CandidateRepositoryInput, LinearActivityClient, PlanStep, RepositorySuggestion, SelectOption } from "./activities";
export type { HandleAppUserNotificationInput } from "./notification";

export type LinearSessionStatus =
  SessionStatus;
