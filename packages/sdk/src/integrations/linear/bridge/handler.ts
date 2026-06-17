import { LinearDocument as L } from "@linear/sdk";

import { UnsupportedFeatureError } from "../../../core/errors";
import { NoopLogger, type Logger } from "../../../core/logger";
import type { RestApi } from "../../../client/rest/types";
import type { PeerRecord } from "../../../contracts/dtos";
import type {
  HandleAgentSessionEventInput,
  LinearThenvoiBridgeConfig,
  PendingBootstrapRequest,
  SessionRoomStore,
  SessionRoomRecord,
} from "../types";
import { dedupeHandles, stripHandlePrefix } from "../handles";
import { postThought, postError } from "../activities";
import { sendRecoveryActivityIfStale } from "../stale-session-guard";
import {
  buildBridgeMessage,
  detectSessionIntent,
  extractIssueAssigneeField,
  extractIssueDelegateField,
  extractIssueStateField,
  extractIssueTeamId,
  extractIssueTeamKey,
  extractIssueTeamName,
  extractPromptedResponseBody,
  type SessionIntent,
} from "./message";

interface NormalizedBridgeConfig {
  roomStrategy: "issue" | "session";
  writebackMode: "final_only" | "activity_stream";
  hostAgentHandle: string | null;
  thenvoiAppBaseUrl: string;
}

const DEFAULT_THENVOI_APP_BASE_URL = "https://app.thenvoi.com";

const SUPPORTED_ACTIONS = new Set(["created", "updated", "canceled", "prompted"]);
const MAX_PEER_LOOKUP_PAGES = 25;
const PEER_PAGE_SIZE = 100;
const RECOVERED_ROOM_EVENT_RETRY_LIMIT = 2;
const RECOVERED_ROOM_EVENT_RETRY_BASE_DELAY_MS = 1_000;

// Issue state types eligible for auto-start.
const AUTO_START_ELIGIBLE_TYPES: Set<string> = new Set(["backlog", "unstarted", "triage"]);

export interface LinearBridgeRuntime {
  roomResolutionLocks: Map<string, Promise<SessionRoomRecord>>;
  resolvedHostHandleCache: WeakMap<RestApi, string>;
  authenticatedHostHandleCache: WeakMap<RestApi, string>;
}

export function createLinearBridgeRuntime(): LinearBridgeRuntime {
  return {
    roomResolutionLocks: new Map<string, Promise<SessionRoomRecord>>(),
    resolvedHostHandleCache: new WeakMap<RestApi, string>(),
    authenticatedHostHandleCache: new WeakMap<RestApi, string>(),
  };
}

export function getAgentSessionEventKey(
  payload: HandleAgentSessionEventInput["payload"],
): string {
  return [
    payload.agentSession.id,
    normalizeAction(payload.action) ?? String(payload.action ?? "unknown"),
    payload.agentSession.updatedAt ?? payload.agentSession.createdAt ?? "",
    typeof payload.webhookTimestamp === "number" ? String(payload.webhookTimestamp) : "",
  ].join(":");
}

export async function handleAgentSessionEvent(
  input: HandleAgentSessionEventInput,
  options?: {
    skipAcknowledgment?: boolean;
    expectedEventKey?: string;
    skipRoomWrite?: boolean;
    runtime?: LinearBridgeRuntime;
  },
): Promise<void> {
  const logger = input.deps.logger ?? new NoopLogger();
  const config = normalizeConfig(input.config);
  const action = normalizeAction(input.payload.action);
  const runtime = options?.runtime ?? createLinearBridgeRuntime();

  if (!action) {
    logger.warn("linear_thenvoi_bridge.ignored_unknown_action", {
      action: input.payload.action,
      sessionId: input.payload.agentSession.id,
    });
    return;
  }

  const sessionId = input.payload.agentSession.id;
  const issueId = input.payload.agentSession.issueId ?? input.payload.agentSession.issue?.id ?? null;
  const eventKey = options?.expectedEventKey ?? getAgentSessionEventKey(input.payload);
  const existingBySession = await input.deps.store.getBySessionId(sessionId);
  if (existingBySession?.lastEventKey === eventKey) {
    logger.info("linear_thenvoi_bridge.duplicate_event_skipped", {
      sessionId,
      issueId,
      action,
      eventKey,
    });
    return;
  }

  if (action === "canceled") {
    await handleCanceledAction({
      deps: input.deps,
      logger,
      sessionId,
      issueId,
      eventKey,
      payloadAction: input.payload.action,
      skipRoomWrite: options?.skipRoomWrite ?? false,
    });
    return;
  }

  if (action === "prompted") {
    await handlePromptedAction({
      deps: input.deps,
      config,
      logger,
      sessionId,
      eventKey,
      payload: input.payload,
      skipRoomWrite: options?.skipRoomWrite ?? false,
    });
    return;
  }

  // If the session already exists and may have gone stale, send a recovery
  // activity before the main update so Linear reactivates the session.
  if (action === "updated" && existingBySession) {
    await sendRecoveryActivityIfStale({
      session: existingBySession,
      linearClient: input.deps.linearClient,
      store: input.deps.store,
      logger,
    });
  }

  // Acknowledge receipt to Linear before room resolution (created only).
  let lastLinearActivityAt: string | null = null;
  if (action === "created" && !options?.skipAcknowledgment) {
    try {
      await postThought(input.deps.linearClient, sessionId, "Received session. Setting up workspace...");
      lastLinearActivityAt = new Date().toISOString();
    } catch (ackError) {
      logger.warn("linear_thenvoi_bridge.acknowledgment_failed", {
        sessionId,
        error: ackError instanceof Error ? ackError.message : String(ackError),
      });
    }
  }

  // Auto-delegate: fire in background, runs concurrently with room resolution (best-effort).
  let delegatePromise: Promise<{ set: boolean; delegateName: string | null }> | undefined;
  if (action === "created" && issueId) {
    const appUserId = input.payload.appUserId;
    if (appUserId) {
      delegatePromise = trySetAgentAsDelegate({
        linearClient: input.deps.linearClient,
        issueId,
        appUserId,
        logger,
      }).catch((delegateError) => {
        logger.warn("linear_thenvoi_bridge.auto_delegate_failed", {
          sessionId,
          issueId,
          appUserId,
          error: delegateError instanceof Error ? delegateError.message : String(delegateError),
        });
        return { set: false, delegateName: null };
      });
    }
  }

  // Auto-start: fire in background, runs concurrently with room resolution (best-effort).
  let autoStartPromise: Promise<AutoStartResult> | undefined;
  if (action === "created" && issueId) {
    const originalStateType = extractIssueStateField(input.payload.agentSession.issue, "type");
    const teamId = extractIssueTeamId(input.payload.agentSession.issue);
    if (teamId && originalStateType && AUTO_START_ELIGIBLE_TYPES.has(originalStateType)) {
      autoStartPromise = tryMoveIssueToStarted({
        linearClient: input.deps.linearClient,
        issueId,
        teamId,
        logger,
      }).catch((autoStartError) => {
        logger.warn("linear_thenvoi_bridge.auto_start_failed", {
          sessionId,
          issueId,
          teamId,
          error: autoStartError instanceof Error ? autoStartError.message : String(autoStartError),
        });
        return { moved: false, stateId: null, stateName: null };
      });
    }
  }

  let roomRecord: SessionRoomRecord | null = null;
  let externalUrlPromise: Promise<void> | undefined;
  try {
    const hostAgentHandle = await resolveHostAgentHandle({
      thenvoiRest: input.deps.thenvoiRest,
      configuredHostHandle: config.hostAgentHandle,
      logger,
      runtime,
    });
    const existingByIssue = config.roomStrategy === "issue" && issueId
      ? await input.deps.store.getByIssueId(issueId)
      : null;
    roomRecord = await resolveRoomRecord({
      thenvoiRest: input.deps.thenvoiRest,
      store: input.deps.store,
      roomStrategy: config.roomStrategy,
      sessionId,
      issueId,
      logger,
      runtime,
    });
    if (action === "created") {
      const roomId = roomRecord.thenvoiRoomId;
      externalUrlPromise = trySetSessionExternalUrl({
        linearClient: input.deps.linearClient,
        sessionId,
        roomId,
        appBaseUrl: config.thenvoiAppBaseUrl,
        logger,
      }).catch((urlError) => {
        logger.warn("linear_thenvoi_bridge.set_external_url_failed", {
          sessionId,
          roomId,
          error: urlError instanceof Error ? urlError.message : String(urlError),
        });
      });
    }

    // Intent is computed from the *original* state type (before auto-start) so it reflects
    // why the session was created (e.g. "planning" for backlog issues), not the state we moved it to.
    const sessionIntent = detectSessionIntent({
      issueStateType: extractIssueStateField(input.payload.agentSession.issue, "type"),
      promptContext: input.payload.promptContext,
      commentBody: input.payload.agentSession.comment?.body,
      issueTitle: input.payload.agentSession.issue?.title,
      issueDescription: input.payload.agentSession.issue?.description,
    });
    const suggestedPeerHandles = await selectRelevantPeerHandles({
      thenvoiRest: input.deps.thenvoiRest,
      roomId: roomRecord.thenvoiRoomId,
      intent: sessionIntent,
      hostAgentHandle,
      planningAgentHandles: input.config.planningAgentHandles,
      implementationAgentHandles: input.config.implementationAgentHandles,
      logger,
    });

    await ensureRoomParticipants({
      thenvoiRest: input.deps.thenvoiRest,
      roomId: roomRecord.thenvoiRoomId,
      handles: [hostAgentHandle],
      logger,
    });

    // Await auto-delegate before building the message so delegate info is up-to-date.
    // The promise already has a .catch() at creation that converts errors to { set: false, delegateName: null }.
    const delegateResult = await delegatePromise;

    let issueDelegateId = extractIssueDelegateField(input.payload.agentSession.issue, "id");
    let issueDelegateName: string | null =
      extractIssueDelegateField(input.payload.agentSession.issue, "displayName")
      ?? extractIssueDelegateField(input.payload.agentSession.issue, "name");
    if (delegateResult?.set && input.payload.appUserId) {
      issueDelegateId = input.payload.appUserId;
      issueDelegateName = delegateResult.delegateName ?? input.payload.appUserId;
    }

    // Await auto-start before building the message so issue state info is up-to-date.
    // The promise already has a .catch() at creation that converts errors to { moved: false }.
    const autoStartResult = await autoStartPromise;

    let issueStateId = extractIssueStateField(input.payload.agentSession.issue, "id");
    let issueStateName = extractIssueStateField(input.payload.agentSession.issue, "name");
    let resolvedStateType = extractIssueStateField(input.payload.agentSession.issue, "type");
    if (autoStartResult?.moved) {
      if (autoStartResult.stateId) issueStateId = autoStartResult.stateId;
      if (autoStartResult.stateName) issueStateName = autoStartResult.stateName;
      resolvedStateType = "started";
    }

    const message = buildBridgeMessage({
      sessionId,
      issueId,
      issueIdentifier: input.payload.agentSession.issue?.identifier,
      sessionStatus: input.payload.agentSession.status,
      sessionType: input.payload.agentSession.type,
      sessionCreatedAt: input.payload.agentSession.createdAt,
      sessionUpdatedAt: input.payload.agentSession.updatedAt,
      action,
      hostHandle: hostAgentHandle,
      promptContext: input.payload.promptContext,
      issueTitle: input.payload.agentSession.issue?.title,
      issueDescription: input.payload.agentSession.issue?.description,
      issueUrl: input.payload.agentSession.issue?.url,
      issueTeamKey: extractIssueTeamKey(input.payload.agentSession.issue),
      issueTeamName: extractIssueTeamName(input.payload.agentSession.issue),
      issueTeamId: extractIssueTeamId(input.payload.agentSession.issue),
      issueStateId,
      issueStateName,
      issueStateType: resolvedStateType,
      issueAssigneeId: extractIssueAssigneeField(input.payload.agentSession.issue, "id"),
      issueAssigneeName:
        extractIssueAssigneeField(input.payload.agentSession.issue, "displayName")
        ?? extractIssueAssigneeField(input.payload.agentSession.issue, "name"),
      issueDelegateId,
      issueDelegateName,
      commentBody: input.payload.agentSession.comment?.body,
      commentId: input.payload.agentSession.comment?.id,
      sessionIntent,
      suggestedPeerHandles,
      webhookId: input.payload.webhookId,
      webhookTimestamp: input.payload.webhookTimestamp,
      oauthClientId: input.payload.oauthClientId,
      organizationId: input.payload.organizationId,
      appUserId: input.payload.appUserId,
      writebackMode: config.writebackMode,
    });

    const messageMetadata = {
      linear_event_action: action,
      linear_session_id: sessionId,
      linear_issue_id: issueId,
      linear_prompt_context: input.payload.promptContext ?? null,
      linear_writeback_mode: config.writebackMode,
      linear_bridge: "thenvoi",
      linear_host_handle: hostAgentHandle,
    };
    const shouldResetRoomSession = Boolean(
      existingByIssue
      && existingByIssue.linearSessionId !== sessionId
      && existingByIssue.thenvoiRoomId === roomRecord.thenvoiRoomId
      && (existingByIssue.status === "completed" || existingByIssue.status === "errored"),
    );

    const authenticatedHostHandle = runtime.authenticatedHostHandleCache.get(input.deps.thenvoiRest) ?? null;
    const canBootstrapDirectly = options?.skipRoomWrite === true
      || authenticatedHostHandle === null
      || authenticatedHostHandle === hostAgentHandle;
    if (!options?.skipRoomWrite || !canBootstrapDirectly) {
      roomRecord = await forwardBridgeMessage({
        thenvoiRest: input.deps.thenvoiRest,
        store: input.deps.store,
        logger,
        roomRecord,
        hostAgentHandle,
        sessionId,
        issueId,
        message,
        messageType: "task",
        metadata: messageMetadata,
        recoveredRoomRetryBaseDelayMs: input.config.recoveredRoomRetryBaseDelayMs,
      });
    }
    if (canBootstrapDirectly) {
      const linearActor = resolveLinearActor(input.payload);
      await enqueueBootstrapRequest(input.deps.store, {
        eventKey,
        linearSessionId: sessionId,
        thenvoiRoomId: roomRecord.thenvoiRoomId,
        expectedContent: message,
        messageType: "task",
        senderId: linearActor.id,
        senderName: linearActor.name,
        metadata: shouldResetRoomSession
          ? {
            ...messageMetadata,
            linear_reset_room_session: true,
          }
          : messageMetadata,
      });
    }

    const now = new Date().toISOString();
    await saveSessionRecord(input.deps.store, {
      ...roomRecord,
      status: "active",
      lastEventKey: eventKey,
      lastLinearActivityAt: lastLinearActivityAt ?? roomRecord.lastLinearActivityAt ?? now,
      updatedAt: now,
    });

    // Ensure external URL has been set before returning (already has .catch, won't throw).
    await externalUrlPromise;

    logger.info("linear_thenvoi_bridge.message_forwarded", {
      sessionId,
      issueId,
      roomId: roomRecord.thenvoiRoomId,
      action,
    });
  } catch (error) {
    // Ensure background operations have settled before re-throwing
    // (promises already have .catch, so these won't throw).
    await externalUrlPromise;
    await delegatePromise;
    await autoStartPromise;

    // Report errors back to Linear before re-throwing.
    try {
      await postError(
        input.deps.linearClient,
        sessionId,
        `Bridge error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } catch (reportError) {
      logger.warn("linear_thenvoi_bridge.error_reporting_failed", {
        sessionId,
        error: reportError instanceof Error ? reportError.message : String(reportError),
      });
    }

    if (roomRecord) {
      await saveSessionRecord(input.deps.store, {
        ...roomRecord,
        status: "errored",
        lastEventKey: eventKey,
        updatedAt: new Date().toISOString(),
      });
    } else if (existingBySession) {
      await saveSessionRecord(input.deps.store, {
        ...existingBySession,
        status: "errored",
        lastEventKey: eventKey,
        updatedAt: new Date().toISOString(),
      });
    }

    throw error;
  }
}

export async function completeLinearSession(input: {
  linearClient: {
    createAgentActivity: (request: {
      agentSessionId: string;
      content: {
        type: L.AgentActivityType;
        body: string;
      };
    }) => Promise<unknown>;
  };
  agentSessionId: string;
  body: string;
  store?: SessionRoomStore;
  lastEventKey?: string | null;
}): Promise<void> {
  await input.linearClient.createAgentActivity({
    agentSessionId: input.agentSessionId,
    content: {
      type: L.AgentActivityType.Response,
      body: input.body,
    },
  });

  if (!input.store) {
    return;
  }

  const existing = await input.store.getBySessionId(input.agentSessionId);
  if (!existing) {
    return;
  }

  const now = new Date().toISOString();
  await saveSessionRecord(input.store, {
    ...existing,
    status: "completed",
    lastEventKey: input.lastEventKey ?? existing.lastEventKey ?? null,
    lastLinearActivityAt: now,
    updatedAt: now,
  });
}

async function trySetSessionExternalUrl(input: {
  linearClient: HandleAgentSessionEventInput["deps"]["linearClient"];
  sessionId: string;
  roomId: string;
  appBaseUrl: string;
  logger: Logger;
}): Promise<void> {
  if (typeof input.linearClient.agentSessionUpdateExternalUrl !== "function") {
    input.logger.info("linear_thenvoi_bridge.set_external_url_skipped_no_api", {
      sessionId: input.sessionId,
    });
    return;
  }

  const base = input.appBaseUrl.replace(/\/+$/, "");
  const roomUrl = `${base}/rooms/${input.roomId}`;
  await input.linearClient.agentSessionUpdateExternalUrl(input.sessionId, {
    externalUrls: [{ label: "View in Thenvoi", url: roomUrl }],
  });

  input.logger.info("linear_thenvoi_bridge.external_url_set", {
    sessionId: input.sessionId,
    roomId: input.roomId,
    url: roomUrl,
  });
}

function normalizeConfig(config: LinearThenvoiBridgeConfig): NormalizedBridgeConfig {
  return {
    roomStrategy: config.roomStrategy ?? "issue",
    writebackMode: config.writebackMode ?? "final_only",
    hostAgentHandle: normalizeOptionalHandle(config.hostAgentHandle),
    thenvoiAppBaseUrl: config.thenvoiAppBaseUrl ?? DEFAULT_THENVOI_APP_BASE_URL,
  };
}

function normalizeOptionalHandle(handle: string | null | undefined): string | null {
  if (!handle) {
    return null;
  }

  const normalized = stripHandlePrefix(handle);
  return normalized.length > 0 ? normalized : null;
}

async function trySetAgentAsDelegate(input: {
  linearClient: HandleAgentSessionEventInput["deps"]["linearClient"];
  issueId: string;
  appUserId: string;
  logger: Logger;
}): Promise<{ set: boolean; delegateName: string | null }> {
  const issue = await input.linearClient.issue(input.issueId);
  const existingDelegateId = issue.delegateId;
  if (existingDelegateId) {
    input.logger.info("linear_thenvoi_bridge.delegate_already_set", {
      issueId: input.issueId,
      existingDelegateId,
    });
    return { set: false, delegateName: null };
  }

  await input.linearClient.updateIssue(input.issueId, {
    delegateId: input.appUserId,
  });

  // Re-fetch the issue to get the delegate's display name for the bridge message.
  let delegateName: string | null = null;
  try {
    const updated = await input.linearClient.issue(input.issueId);
    const delegate = await updated.delegate;
    delegateName = delegate?.displayName ?? delegate?.name ?? null;
  } catch {
    // Best-effort: if re-fetch fails, the caller falls back to appUserId.
  }

  input.logger.info("linear_thenvoi_bridge.delegate_set", {
    issueId: input.issueId,
    delegateId: input.appUserId,
  });
  return { set: true, delegateName };
}

interface AutoStartResult {
  moved: boolean;
  stateId: string | null;
  stateName: string | null;
}

async function tryMoveIssueToStarted(input: {
  linearClient: HandleAgentSessionEventInput["deps"]["linearClient"];
  issueId: string;
  teamId: string;
  logger: Logger;
}): Promise<AutoStartResult> {
  const response = await input.linearClient.workflowStates({
    filter: {
      team: { id: { eq: input.teamId } },
      type: { eq: "started" },
    },
  });

  const nodes = Array.isArray(response.nodes) ? response.nodes : [];

  // Linear paginates at 50 nodes by default — safe for workflow states (teams rarely exceed this).
  const startedStates = [...nodes].sort((a, b) => a.position - b.position);

  const targetState = startedStates[0];
  if (!targetState?.id) {
    input.logger.info("linear_thenvoi_bridge.auto_start_no_started_state", {
      issueId: input.issueId,
      teamId: input.teamId,
    });
    return { moved: false, stateId: null, stateName: null };
  }

  await input.linearClient.updateIssue(input.issueId, {
    stateId: targetState.id,
  });

  input.logger.info("linear_thenvoi_bridge.auto_start_moved", {
    issueId: input.issueId,
    stateId: targetState.id,
    stateName: targetState.name ?? null,
  });

  return {
    moved: true,
    stateId: targetState.id,
    stateName: targetState.name ?? null,
  };
}

async function resolveHostAgentHandle(input: {
  thenvoiRest: RestApi;
  configuredHostHandle: string | null;
  logger: Logger;
  runtime: LinearBridgeRuntime;
}): Promise<string> {
  if (input.configuredHostHandle) {
    input.runtime.resolvedHostHandleCache.set(input.thenvoiRest, input.configuredHostHandle);
    return input.configuredHostHandle;
  }

  const cachedAuthenticated = input.runtime.authenticatedHostHandleCache.get(input.thenvoiRest);
  if (cachedAuthenticated) {
    input.runtime.resolvedHostHandleCache.set(input.thenvoiRest, cachedAuthenticated);
    return cachedAuthenticated;
  }

  const cached = input.runtime.resolvedHostHandleCache.get(input.thenvoiRest);
  if (cached) {
    return cached;
  }

  const identity = await input.thenvoiRest.getAgentMe();
  const authenticatedAgentHandle = normalizeOptionalHandle(identity.handle);
  if (authenticatedAgentHandle) {
    input.runtime.authenticatedHostHandleCache.set(input.thenvoiRest, authenticatedAgentHandle);
    input.runtime.resolvedHostHandleCache.set(input.thenvoiRest, authenticatedAgentHandle);
    return authenticatedAgentHandle;
  }

  throw new Error(
    "Linear bridge could not resolve the host agent handle. Set hostAgentHandle or use a REST adapter whose getAgentMe() returns handle.",
  );
}

type SupportedAction = "created" | "updated" | "canceled" | "prompted";

function normalizeAction(action: string | null | undefined): SupportedAction | null {
  if (!action) {
    return null;
  }

  const normalized = action.trim().toLowerCase();
  if (!SUPPORTED_ACTIONS.has(normalized)) {
    return null;
  }

  return normalized as SupportedAction;
}

async function handleCanceledAction(input: {
  deps: HandleAgentSessionEventInput["deps"];
  logger: Logger;
  sessionId: string;
  issueId: string | null;
  eventKey: string;
  payloadAction: string;
  skipRoomWrite: boolean;
}): Promise<void> {
  const existing = await input.deps.store.getBySessionId(input.sessionId);
  if (!existing) {
    input.logger.info("linear_thenvoi_bridge.session_canceled_without_room", {
      sessionId: input.sessionId,
      issueId: input.issueId,
      action: input.payloadAction,
    });
    return;
  }

  await saveSessionRecord(input.deps.store, {
    ...existing,
    status: "canceled",
    lastEventKey: input.eventKey,
    updatedAt: new Date().toISOString(),
  });

  if (!input.skipRoomWrite) {
    await input.deps.thenvoiRest.createChatEvent(existing.thenvoiRoomId, {
      content: "[Linear]: Agent session canceled. Stop in-room execution and await new instructions.",
      messageType: "task",
      metadata: {
        linear_event_action: "canceled",
        linear_session_id: input.sessionId,
        linear_issue_id: input.issueId,
        linear_bridge: "thenvoi",
      },
    });
  }

  input.logger.info("linear_thenvoi_bridge.session_canceled", {
    sessionId: input.sessionId,
    issueId: input.issueId,
    hadRoom: Boolean(existing),
    action: input.payloadAction,
  });
}

async function handlePromptedAction(input: {
  deps: HandleAgentSessionEventInput["deps"];
  config: NormalizedBridgeConfig;
  logger: Logger;
  sessionId: string;
  eventKey: string;
  payload: HandleAgentSessionEventInput["payload"];
  skipRoomWrite: boolean;
}): Promise<void> {
  const existing = await input.deps.store.getBySessionId(input.sessionId);

  if (!existing) {
    input.logger.warn("linear_thenvoi_bridge.prompted_no_room", {
      sessionId: input.sessionId,
    });
    return;
  }

  const userResponse = extractPromptedResponseBody(input.payload);

  if (!userResponse) {
    input.logger.warn("linear_thenvoi_bridge.prompted_empty_response", {
      sessionId: input.sessionId,
    });
    return;
  }

  // Send a recovery activity if the session may have gone stale while waiting.
  await sendRecoveryActivityIfStale({
    session: existing,
    linearClient: input.deps.linearClient,
    store: input.deps.store,
    logger: input.logger,
  });

  const message = `[Linear User Response]: ${userResponse}`;
  const metadata = {
    linear_event_action: "prompted",
    linear_session_id: input.sessionId,
    linear_bridge: "thenvoi",
  };

  const canBootstrapDirectly = input.config.hostAgentHandle !== null
    ? true
    : Boolean(normalizeOptionalHandle((await input.deps.thenvoiRest.getAgentMe()).handle));
  if (!input.skipRoomWrite || !canBootstrapDirectly) {
    await input.deps.thenvoiRest.createChatEvent(existing.thenvoiRoomId, {
      content: message,
      messageType: "text",
      metadata,
    });
  }
  if (canBootstrapDirectly) {
    const linearActor = resolveLinearActor(input.payload);
    await enqueueBootstrapRequest(input.deps.store, {
      eventKey: input.eventKey,
      linearSessionId: input.sessionId,
      thenvoiRoomId: existing.thenvoiRoomId,
      expectedContent: message,
      messageType: "text",
      senderId: linearActor.id,
      senderName: linearActor.name,
      metadata,
    });
  }

  await saveSessionRecord(input.deps.store, {
    ...existing,
    status: "waiting",
    lastEventKey: input.eventKey,
    updatedAt: new Date().toISOString(),
  });

  input.logger.info("linear_thenvoi_bridge.prompted_forwarded", {
    sessionId: input.sessionId,
    roomId: existing.thenvoiRoomId,
  });
}

async function enqueueBootstrapRequest(
  store: SessionRoomStore,
  request: Pick<
    PendingBootstrapRequest,
    | "eventKey"
    | "linearSessionId"
    | "thenvoiRoomId"
    | "expectedContent"
    | "messageType"
    | "senderId"
    | "senderName"
    | "metadata"
  >,
): Promise<void> {
  const now = new Date();
  await store.enqueueBootstrapRequest({
    ...request,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
  });
}

function resolveLinearActor(payload: HandleAgentSessionEventInput["payload"]): {
  id: string | null;
  name: string;
} {
  const creator = payload.agentSession.creator;
  const creatorName = typeof creator?.name === "string" ? creator.name.trim() : "";
  const creatorId = typeof creator?.id === "string" ? creator.id.trim() : "";
  if (creatorName.length > 0) {
    return {
      id: creatorId.length > 0 ? creatorId : payload.agentSession.creatorId ?? payload.appUserId ?? null,
      name: creatorName,
    };
  }

  return {
    id: payload.agentSession.creatorId ?? payload.appUserId ?? null,
    name: "Linear User",
  };
}

async function resolveRoomRecord(input: {
  thenvoiRest: RestApi;
  store: HandleAgentSessionEventInput["deps"]["store"];
  roomStrategy: "issue" | "session";
  sessionId: string;
  issueId: string | null;
  logger: Logger;
  runtime: LinearBridgeRuntime;
}): Promise<SessionRoomRecord> {
  // Keep a single in-flight room lookup when multiple sessions target one issue.
  const lockScope = input.roomStrategy === "issue" && input.issueId
    ? `issue:${input.issueId}`
    : `session:${input.sessionId}`;
  const existing = input.runtime.roomResolutionLocks.get(lockScope);
  if (existing) {
    return existing;
  }

  const promise = resolveRoomRecordImpl(input);
  input.runtime.roomResolutionLocks.set(lockScope, promise);
  try {
    return await promise;
  } finally {
    input.runtime.roomResolutionLocks.delete(lockScope);
  }
}

async function forwardBridgeMessage(input: {
  thenvoiRest: RestApi;
  store: SessionRoomStore;
  logger: Logger;
  roomRecord: SessionRoomRecord;
  hostAgentHandle: string;
  sessionId: string;
  issueId: string | null;
  message: string;
  messageType: string;
  metadata: Record<string, unknown>;
  recoveredRoomRetryBaseDelayMs?: number;
}): Promise<SessionRoomRecord> {
  try {
    await input.thenvoiRest.createChatEvent(input.roomRecord.thenvoiRoomId, {
      content: input.message,
      messageType: input.messageType,
      metadata: input.metadata,
    });
    return input.roomRecord;
  } catch (error) {
    if (!isRecoverableRoomAccessError(error)) {
      throw error;
    }

    input.logger.warn("linear_thenvoi_bridge.room_forward_recovering_with_fresh_room", {
      sessionId: input.sessionId,
      issueId: input.issueId,
      previousRoomId: input.roomRecord.thenvoiRoomId,
      error: error instanceof Error ? error.message : String(error),
    });

    const recoveredRoom = await createFreshRoomRecord({
      thenvoiRest: input.thenvoiRest,
      store: input.store,
      sessionId: input.sessionId,
      issueId: input.issueId,
      logger: input.logger,
    });

    await ensureRoomParticipants({
      thenvoiRest: input.thenvoiRest,
      roomId: recoveredRoom.thenvoiRoomId,
      handles: [input.hostAgentHandle],
      logger: input.logger,
    });

    let attempt = 0;
    while (true) {
      try {
        await input.thenvoiRest.createChatEvent(recoveredRoom.thenvoiRoomId, {
          content: input.message,
          messageType: input.messageType,
          metadata: input.metadata,
        });
        return recoveredRoom;
      } catch (recoveredError) {
        if (!isRetryableRecoveredRoomEventError(recoveredError) || attempt >= RECOVERED_ROOM_EVENT_RETRY_LIMIT) {
          throw recoveredError;
        }

        attempt += 1;
        const retryBaseDelayMs = input.recoveredRoomRetryBaseDelayMs ?? RECOVERED_ROOM_EVENT_RETRY_BASE_DELAY_MS;
        const delayMs = retryBaseDelayMs * attempt;
        input.logger.warn("linear_thenvoi_bridge.room_recreated_retrying", {
          sessionId: input.sessionId,
          issueId: input.issueId,
          roomId: recoveredRoom.thenvoiRoomId,
          attempt,
          delayMs,
          error: recoveredError instanceof Error ? recoveredError.message : String(recoveredError),
        });
        await sleep(delayMs);
      }
    }
  }
}

function isRecoverableRoomAccessError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /\/api\/v1\/agent\/chats\/.+\/events failed \((403|404)/.test(error.message);
}

function isRetryableRecoveredRoomEventError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /\/api\/v1\/agent\/chats\/.+\/events failed \((403|404|429)/.test(error.message);
}

function isRetryableRateLimitError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "retryable" in error) {
    return (error as { retryable?: boolean }).retryable === true;
  }

  return error instanceof Error && /\b429\b/.test(error.message);
}

async function createFreshRoomRecord(input: {
  thenvoiRest: RestApi;
  store: SessionRoomStore;
  sessionId: string;
  issueId: string | null;
  logger: Logger;
}): Promise<SessionRoomRecord> {
  const now = new Date().toISOString();
  const created = await input.thenvoiRest.createChat();
  const record: SessionRoomRecord = {
    linearSessionId: input.sessionId,
    linearIssueId: input.issueId,
    thenvoiRoomId: created.id,
    status: "active",
    lastEventKey: null,
    createdAt: now,
    updatedAt: now,
  };

  await input.store.upsert(record);
  input.logger.info("linear_thenvoi_bridge.room_recreated", {
    sessionId: input.sessionId,
    issueId: input.issueId,
    roomId: created.id,
  });
  return record;
}

async function resolveRoomRecordImpl(input: {
  thenvoiRest: RestApi;
  store: HandleAgentSessionEventInput["deps"]["store"];
  roomStrategy: "issue" | "session";
  sessionId: string;
  issueId: string | null;
  logger: Logger;
}): Promise<SessionRoomRecord> {
  const existingBySession = await input.store.getBySessionId(input.sessionId);
  if (existingBySession && existingBySession.status !== "canceled") {
    return existingBySession;
  }

  if (input.roomStrategy === "issue" && input.issueId) {
    const existingByIssue = await input.store.getByIssueId(input.issueId);
    if (existingByIssue && existingByIssue.status !== "canceled") {
      const now = new Date().toISOString();
      const linkedRecord: SessionRoomRecord = {
        linearSessionId: input.sessionId,
        linearIssueId: input.issueId,
        thenvoiRoomId: existingByIssue.thenvoiRoomId,
        status: "active",
        lastEventKey: existingBySession?.lastEventKey ?? null,
        createdAt: existingBySession?.createdAt ?? now,
        updatedAt: now,
      };

      await input.store.upsert(linkedRecord);
      return linkedRecord;
    }
  }

  const now = new Date().toISOString();
  // Thenvoi validates `chat.task_id` as a Thenvoi task UUID. Linear issue/session IDs
  // are external identifiers, so this bridge must omit `task_id` unless it has a real
  // Thenvoi task to associate with the room.
  const created = await input.thenvoiRest.createChat();
  const createdRecord: SessionRoomRecord = {
    linearSessionId: input.sessionId,
    linearIssueId: input.issueId,
    thenvoiRoomId: created.id,
    status: "active",
    lastEventKey: null,
    createdAt: now,
    updatedAt: now,
  };

  await input.store.upsert(createdRecord);

  input.logger.info("linear_thenvoi_bridge.room_created", {
    sessionId: input.sessionId,
    issueId: input.issueId,
    roomId: created.id,
    roomStrategy: input.roomStrategy,
  });

  return createdRecord;
}

async function ensureRoomParticipants(input: {
  thenvoiRest: RestApi;
  roomId: string;
  handles: string[];
  logger: Logger;
}): Promise<void> {
  if (input.handles.length === 0) {
    return;
  }

  let existingParticipants;
  try {
    existingParticipants = await input.thenvoiRest.listChatParticipants(input.roomId);
  } catch (error) {
    if (isRetryableRateLimitError(error)) {
      input.logger.warn("linear_thenvoi_bridge.participant_list_rate_limited", {
        roomId: input.roomId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    throw error;
  }
  const existingHandles = new Set(
    existingParticipants
      .map((participant) => stripHandlePrefix(participant.handle ?? participant.name))
      .filter((value): value is string => value.length > 0),
  );

  const missingHandles = input.handles.filter((handle) => !existingHandles.has(handle));
  if (missingHandles.length === 0) {
    return;
  }

  let peersByHandle: Map<string, string>;
  try {
    peersByHandle = await lookupPeerIdsByHandle(input.thenvoiRest, input.roomId, missingHandles);
  } catch (error) {
    if (error instanceof UnsupportedFeatureError) {
      input.logger.warn("linear_thenvoi_bridge.peer_lookup_unavailable", {
        roomId: input.roomId,
        missingHandles,
        reason: error.message,
      });
      return;
    }

    throw error;
  }

  for (const handle of missingHandles) {
    const participantId = peersByHandle.get(handle);
    if (!participantId) {
      input.logger.warn("linear_thenvoi_bridge.peer_not_found", {
        roomId: input.roomId,
        handle,
      });
      continue;
    }

    try {
      await input.thenvoiRest.addChatParticipant(
        input.roomId,
        {
          participantId,
          role: "member",
        },
      );
    } catch (error) {
      input.logger.warn("linear_thenvoi_bridge.add_participant_failed", {
        roomId: input.roomId,
        handle,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!isRetryableRateLimitError(error)) {
        throw error;
      }
    }
  }
}

async function lookupPeerIdsByHandle(
  thenvoiRest: RestApi,
  roomId: string,
  handles: string[],
): Promise<Map<string, string>> {
  if (!thenvoiRest.listPeers) {
    throw new UnsupportedFeatureError("Peer listing is not available in current REST adapter");
  }

  const targets = new Set(handles);
  const found = new Map<string, string>();

  for (let page = 1; page <= MAX_PEER_LOOKUP_PAGES && found.size < targets.size; page += 1) {
    const response = await thenvoiRest.listPeers({
      page,
      pageSize: PEER_PAGE_SIZE,
      notInChat: roomId,
    });

    for (const peer of response.data) {
      const peerId = peer.id;
      if (typeof peerId !== "string" || peerId.length === 0) {
        continue;
      }

      const handleCandidates = [
        typeof peer.handle === "string" ? stripHandlePrefix(peer.handle) : "",
        typeof peer.name === "string" ? stripHandlePrefix(peer.name) : "",
      ].filter((value): value is string => value.length > 0);

      for (const candidate of handleCandidates) {
        if (!targets.has(candidate)) {
          continue;
        }

        found.set(candidate, peerId);
      }
    }

    if (response.data.length < PEER_PAGE_SIZE) {
      break;
    }
  }

  return found;
}

async function selectRelevantPeerHandles(input: {
  thenvoiRest: RestApi;
  roomId: string;
  intent: SessionIntent;
  hostAgentHandle: string;
  planningAgentHandles?: string[];
  implementationAgentHandles?: string[];
  logger: Logger;
}): Promise<string[]> {
  const configuredHandles = resolveConfiguredSpecialistHandles(input.intent, {
    planningAgentHandles: input.planningAgentHandles,
    implementationAgentHandles: input.implementationAgentHandles,
  }).filter((handle) => handle !== input.hostAgentHandle);
  if (configuredHandles.length > 0) {
    input.logger.info("linear_thenvoi_bridge.peer_prefetch_selected", {
      roomId: input.roomId,
      intent: input.intent,
      handles: configuredHandles,
      source: "configured",
    });
    return configuredHandles;
  }

  if (!input.thenvoiRest.listPeers) {
    return [];
  }

  let peers: PeerRecord[];
  try {
    const response = await input.thenvoiRest.listPeers({
      page: 1,
      pageSize: PEER_PAGE_SIZE,
      notInChat: input.roomId,
    });
    peers = response.data;
  } catch (error) {
    if (error instanceof UnsupportedFeatureError) {
      return [];
    }

    input.logger.warn("linear_thenvoi_bridge.peer_prefetch_failed", {
      roomId: input.roomId,
      intent: input.intent,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const ranked = peers
    .map((peer) => {
      const handle = normalizeOptionalHandle(typeof peer.handle === "string" ? peer.handle : null);
      return {
        handle,
        score: scorePeerForIntent(peer, input.intent),
      };
    })
    .filter((candidate): candidate is { handle: string; score: number } =>
      typeof candidate.handle === "string"
      && candidate.handle.length > 0
      && candidate.handle !== input.hostAgentHandle,
    )
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  const selected = ranked.slice(0, 2).map((candidate) => candidate.handle);
  if (selected.length > 0) {
    input.logger.info("linear_thenvoi_bridge.peer_prefetch_selected", {
      roomId: input.roomId,
      intent: input.intent,
      handles: selected,
      source: "lookup",
    });
  }

  return selected;
}

function resolveConfiguredSpecialistHandles(
  intent: SessionIntent,
  config: { planningAgentHandles?: string[]; implementationAgentHandles?: string[] },
): string[] {
  const handles = intent === "implementation"
    ? config.implementationAgentHandles
    : config.planningAgentHandles;

  if (!handles || handles.length === 0) {
    return [];
  }

  const configured = handles
    .map((value) => normalizeOptionalHandle(value))
    .filter((value): value is string => Boolean(value));

  if (intent === "implementation") {
    return dedupeHandles(configured);
  }

  const ranked = configured
    .map((handle) => ({
      handle,
      score: /\bplanner\b/.test(handle) ? 3 : /\breviewer\b|\bcodex\b/.test(handle) ? 2 : 1,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 2)
    .map((entry) => entry.handle);

  return dedupeHandles(ranked);
}

function scorePeerForIntent(peer: PeerRecord, intent: SessionIntent): number {
  const description = typeof peer.description === "string" ? peer.description : "";
  const haystack = [
    typeof peer.name === "string" ? peer.name : "",
    typeof peer.handle === "string" ? peer.handle : "",
    description,
  ].join(" ").toLowerCase();

  const weightedTerms = intent === "implementation"
    ? [
      { pattern: /\bimplementer\b|\bimplementation\b/, score: 10 },
      { pattern: /\bengineer\b|\bdeveloper\b|\bcoder\b|\bcoding\b/, score: 8 },
      { pattern: /\bbuild\b|\bfrontend\b|\bui\b/, score: 5 },
      { pattern: /\breviewer\b|\breview\b|\bplanner\b|\bplan\b/, score: -4 },
    ]
    : [
      { pattern: /\bplanner\b|\bplanning\b|\bplan\b/, score: 10 },
      { pattern: /\bclaude\b/, score: 8 },
      { pattern: /\breviewer\b|\breview\b|\bcodex\b/, score: 7 },
      { pattern: /\borchestrator\b|\barchitect\b|\bdesign\b|\bscope\b|\bspec\b/, score: 6 },
      { pattern: /\bimplementer\b|\bimplementation\b/, score: -3 },
    ];

  return weightedTerms.reduce((total, term) => (term.pattern.test(haystack) ? total + term.score : total), 0);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function saveSessionRecord(
  store: SessionRoomStore,
  record: SessionRoomRecord,
): Promise<void> {
  await store.upsert(record);
}
