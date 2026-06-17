import type { IncomingMessage, ServerResponse } from "node:http";

import {
  LinearWebhookClient,
  LINEAR_WEBHOOK_SIGNATURE_HEADER,
  LINEAR_WEBHOOK_TS_HEADER,
  type AgentSessionEventWebhookPayload,
  type AppUserNotificationWebhookPayloadWithNotification,
  type AppUserTeamAccessChangedWebhookPayload,
  type OAuthAppWebhookPayload,
} from "@linear/sdk/webhooks";

import { NoopLogger, type Logger } from "../../core/logger";
import { handleAppUserNotification } from "./notification";
import { postError, postThought } from "./activities";
import {
  createLinearBridgeRuntime,
  getAgentSessionEventKey,
  handleAgentSessionEvent,
  type LinearBridgeRuntime,
} from "./bridge";
import type {
  HandleAgentSessionEventInput,
  LinearThenvoiBridgeConfig,
  LinearThenvoiBridgeDeps,
} from "./types";

export interface LinearBridgeDispatchJob {
  eventKey: string;
  input: HandleAgentSessionEventInput;
  runtime?: LinearBridgeRuntime;
}

export interface LinearBridgeDispatcher {
  dispatch(job: LinearBridgeDispatchJob): Promise<void> | void;
  isQueued?(eventKey: string): boolean;
  waitForIdle?(): Promise<void>;
}

export interface PermissionChangeCallbacks {
  onTeamAccessChanged?: (payload: AppUserTeamAccessChangedWebhookPayload) => void | Promise<void>;
  onOAuthAppRevoked?: (payload: OAuthAppWebhookPayload) => void | Promise<void>;
}

export interface CreateLinearWebhookHandlerOptions {
  config: LinearThenvoiBridgeConfig;
  deps: LinearThenvoiBridgeDeps;
  dispatcher?: LinearBridgeDispatcher;
  permissionCallbacks?: PermissionChangeCallbacks;
}

type NodeRequestWithBody = IncomingMessage & {
  body?: Buffer | string | Uint8Array | null;
};

const DISPATCH_RETRY_LIMIT = 2;
const DISPATCH_RETRY_BASE_DELAY_MS = 1_000;

interface DispatchTerminalFailure {
  eventKey: string;
  sessionId: string;
  attempts: number;
  error: unknown;
}

type DispatchAttemptResult =
  | { ok: true }
  | { ok: false; attempts: number; error: unknown };

export function createInlineLinearBridgeDispatcher(
  options?: { logger?: Logger },
): LinearBridgeDispatcher {
  const logger = options?.logger ?? new NoopLogger();
  const runtime = createLinearBridgeRuntime();

  return {
    dispatch: async (job: LinearBridgeDispatchJob): Promise<void> => {
      const result = await runDispatchAttempt(async () => {
        await handleAgentSessionEvent(job.input, {
          skipAcknowledgment: true,
          expectedEventKey: job.eventKey,
          runtime: job.runtime ?? runtime,
        });
      }, {
        logger,
        failureEvent: "linear_thenvoi_bridge.dispatch_failed",
        retryEvent: "linear_thenvoi_bridge.dispatch_retrying",
        eventKey: job.eventKey,
        sessionId: job.input.payload.agentSession.id,
      });

      if (result.ok) {
        await markBootstrapHandoffProcessed({
          eventKey: job.eventKey,
          store: job.input.deps.store,
          logger,
          sessionId: job.input.payload.agentSession.id,
        });
        return;
      }

      const failure: DispatchTerminalFailure = {
        eventKey: job.eventKey,
        sessionId: job.input.payload.agentSession.id,
        attempts: result.attempts,
        error: result.error,
      };
      await signalTerminalDispatchFailure({
        logger,
        job,
        failure,
      });

      throw result.error;
    },
  };
}

export function createInProcessLinearBridgeDispatcher(
  options?: { logger?: Logger },
): LinearBridgeDispatcher {
  const logger = options?.logger ?? new NoopLogger();
  const runtime = createLinearBridgeRuntime();
  const queued = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  const terminalFailures: DispatchTerminalFailure[] = [];

  return {
    isQueued: (eventKey: string) => queued.has(eventKey),
    waitForIdle: async (): Promise<void> => {
      let snapshot = [...inFlight];
      while (snapshot.length > 0) {
        await Promise.allSettled(snapshot);
        snapshot = [...inFlight];
      }

      if (terminalFailures.length === 0) {
        return;
      }

      const failures = terminalFailures.splice(0, terminalFailures.length);
      throw new AggregateError(
        failures.map((failure) => toDispatchFailureError(failure)),
        `Linear bridge async dispatch failed for ${failures.length} event(s)`,
      );
    },
    dispatch: async (job: LinearBridgeDispatchJob): Promise<void> => {
      if (queued.has(job.eventKey)) {
        return;
      }

      queued.add(job.eventKey);
      const dispatchTask = (async (): Promise<void> => {
        await new Promise<void>((resolveMicrotask) => {
          queueMicrotask(() => resolveMicrotask());
        });

        const result = await runDispatchAttempt(async () => {
          await handleAgentSessionEvent(job.input, {
            skipAcknowledgment: true,
            expectedEventKey: job.eventKey,
            runtime: job.runtime ?? runtime,
          });
        }, {
          logger,
          failureEvent: "linear_thenvoi_bridge.async_dispatch_failed",
          retryEvent: "linear_thenvoi_bridge.async_dispatch_retrying",
          eventKey: job.eventKey,
          sessionId: job.input.payload.agentSession.id,
        });

        if (result.ok) {
          await markBootstrapHandoffProcessed({
            eventKey: job.eventKey,
            store: job.input.deps.store,
            logger,
            sessionId: job.input.payload.agentSession.id,
          });
          return;
        }

        const failure: DispatchTerminalFailure = {
          eventKey: job.eventKey,
          sessionId: job.input.payload.agentSession.id,
          attempts: result.attempts,
          error: result.error,
        };
        terminalFailures.push(failure);
        await signalTerminalDispatchFailure({
          logger,
          job,
          failure,
        });
      })();

      inFlight.add(dispatchTask);
      void dispatchTask.catch((error) => {
        logger.error("linear_thenvoi_bridge.async_dispatch_failure_signal_crashed", {
          eventKey: job.eventKey,
          sessionId: job.input.payload.agentSession.id,
          error: serializeError(error),
        });
      }).finally(() => {
        queued.delete(job.eventKey);
        inFlight.delete(dispatchTask);
      });
      await dispatchTask;
    },
  };
}

export function createLinearWebhookHandler(
  options: CreateLinearWebhookHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const logger = options.deps.logger ?? new NoopLogger();
  const runtime = createLinearBridgeRuntime();
  const dispatcher = options.dispatcher ?? createInlineLinearBridgeDispatcher({ logger });
  const webhookClient = new LinearWebhookClient(options.config.linearWebhookSecret);
  const inFlightEventKeys = new Set<string>();
  // Best-effort, process-scoped dedup for notification webhooks. Capped at 1 000 entries with
  // FIFO eviction and no TTL — a process restart or a retry arriving after eviction will be
  // reprocessed. This is acceptable because notification handlers are idempotent.
  const processedNotificationIds = new Set<string>();

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      logger.warn("linear_thenvoi_bridge.webhook_invalid_method", {
        method: request.method ?? null,
      });
      sendText(response, 405, "Method not allowed");
      return;
    }

    const signature = getHeaderValue(request, LINEAR_WEBHOOK_SIGNATURE_HEADER);
    if (!signature) {
      logger.warn("linear_thenvoi_bridge.webhook_missing_signature", {});
      sendText(response, 400, "Missing webhook signature");
      return;
    }
    const timestamp = getHeaderValue(request, LINEAR_WEBHOOK_TS_HEADER);
    if (!timestamp) {
      logger.warn("linear_thenvoi_bridge.webhook_missing_timestamp", {});
      sendText(response, 400, "Missing webhook timestamp");
      return;
    }

    const rawBody = await readRawBody(request as NodeRequestWithBody);
    let parsed: { type?: string };
    try {
      parsed = webhookClient.parseData(
        rawBody,
        signature,
        timestamp,
      ) as { type?: string };
    } catch (error) {
      logger.warn("linear_thenvoi_bridge.webhook_invalid_signature", {
        error: error instanceof Error ? error.message : String(error),
      });
      sendText(response, 400, "Invalid webhook");
      return;
    }

    if (parsed.type === "AppUserNotification") {
      const notificationPayload = parsed as AppUserNotificationWebhookPayloadWithNotification;

      if (!notificationPayload.notification) {
        logger.warn("linear_thenvoi_bridge.webhook_notification_missing_payload", {
          appUserId: notificationPayload.appUserId ?? null,
          organizationId: notificationPayload.organizationId ?? null,
        });
        sendText(response, 200, "OK");
        return;
      }

      // The Linear SDK does not expose `id` on the notification union type yet; extract defensively.
      const notificationId: string | undefined =
        (notificationPayload.notification as { id?: string } | undefined)?.id;
      const notificationType = notificationPayload.notification.__typename;
      // Reactions are fire-and-forget (log-only) — don't let them evict actionable entries.
      const isDedupable = notificationType !== "IssueCommentReactionNotificationWebhookPayload"
        && notificationType !== "IssueEmojiReactionNotificationWebhookPayload";

      if (isDedupable && notificationId && processedNotificationIds.has(notificationId)) {
        logger.info("linear_thenvoi_bridge.webhook_notification_duplicate_ignored", {
          notificationId,
        });
        sendText(response, 200, "OK");
        return;
      }

      logger.info("linear_thenvoi_bridge.webhook_notification_received", {
        notificationType: notificationType ?? null,
        notificationId: notificationId ?? null,
        appUserId: notificationPayload.appUserId,
        organizationId: notificationPayload.organizationId,
      });

      try {
        await handleAppUserNotification({
          payload: notificationPayload,
          deps: options.deps,
          logger,
          appUserId: notificationPayload.appUserId,
        });
        // Mark as processed only after the handler succeeds so that a failed notification
        // can be retried by Linear instead of being silently deduped.
        if (isDedupable && notificationId) {
          processedNotificationIds.add(notificationId);
          if (processedNotificationIds.size > 1000) {
            const oldest = processedNotificationIds.values().next().value;
            if (oldest) processedNotificationIds.delete(oldest);
          }
        }
      } catch (error) {
        logger.error("linear_thenvoi_bridge.webhook_notification_failed", {
          notificationType: notificationType ?? null,
          error: serializeError(error),
        });
      }

      sendText(response, 200, "OK");
      return;
    }

    if (parsed.type === "PermissionChange") {
      const action = (parsed as { action?: string }).action;
      if (normalizeAction(action) === "teamaccesschanged") {
        const permPayload = parsed as unknown as AppUserTeamAccessChangedWebhookPayload;
        logger.info("linear_thenvoi_bridge.team_access_changed", {
          action: permPayload.action,
          addedTeamIds: permPayload.addedTeamIds,
          removedTeamIds: permPayload.removedTeamIds,
          canAccessAllPublicTeams: permPayload.canAccessAllPublicTeams,
          organizationId: permPayload.organizationId,
        });

        try {
          await options.permissionCallbacks?.onTeamAccessChanged?.(permPayload);
        } catch (error) {
          logger.error("linear_thenvoi_bridge.team_access_changed_callback_failed", {
            error: serializeError(error),
          });
        }
      } else {
        logger.info("linear_thenvoi_bridge.permission_change_event_ignored", {
          action,
        });
      }

      sendText(response, 200, "OK");
      return;
    }

    if (parsed.type === "OAuthApp") {
      const oauthPayload = parsed as unknown as OAuthAppWebhookPayload;
      if (normalizeAction(oauthPayload.action) === "revoked") {
        logger.warn("linear_thenvoi_bridge.oauth_app_revoked", {
          oauthClientId: oauthPayload.oauthClientId,
          organizationId: oauthPayload.organizationId,
        });

        try {
          await options.permissionCallbacks?.onOAuthAppRevoked?.(oauthPayload);
        } catch (error) {
          logger.error("linear_thenvoi_bridge.oauth_app_revoked_callback_failed", {
            error: serializeError(error),
          });
        }
      } else {
        logger.info("linear_thenvoi_bridge.oauth_app_event_ignored", {
          action: oauthPayload.action,
        });
      }

      sendText(response, 200, "OK");
      return;
    }

    if (parsed.type !== "AgentSessionEvent") {
      logger.info("linear_thenvoi_bridge.webhook_ignored_event", {
        type: parsed.type,
      });
      sendText(response, 200, "OK");
      return;
    }

    const payload = parsed as unknown as AgentSessionEventWebhookPayload;

    const eventKey = getAgentSessionEventKey(payload);
    logger.info("linear_thenvoi_bridge.webhook_received", {
      sessionId: payload.agentSession.id,
      issueId: payload.agentSession.issue?.id ?? null,
      action: payload.action,
      eventKey,
    });
    const existing = await options.deps.store.getBySessionId(payload.agentSession.id);
    const alreadyInFlight = inFlightEventKeys.has(eventKey);
    if (existing?.lastEventKey === eventKey || alreadyInFlight || dispatcher.isQueued?.(eventKey)) {
      logger.info("linear_thenvoi_bridge.webhook_duplicate_ignored", {
        sessionId: payload.agentSession.id,
        eventKey,
      });
      sendText(response, 200, "OK");
      return;
    }
    inFlightEventKeys.add(eventKey);

    try {
      if (normalizeAction(payload.action) === "created") {
        try {
          await postThought(
            options.deps.linearClient,
            payload.agentSession.id,
            "Received session. Setting up workspace...",
          );
        } catch (error) {
          logger.warn("linear_thenvoi_bridge.webhook_acknowledgment_failed", {
            sessionId: payload.agentSession.id,
            error,
          });
        }
      }

      await dispatcher.dispatch({
        eventKey,
        runtime,
        input: {
          payload,
          config: options.config,
          deps: options.deps,
        },
      });
    } catch (error) {
      logger.error("linear_thenvoi_bridge.webhook_dispatch_failed", {
        sessionId: payload.agentSession.id,
        issueId: payload.agentSession.issue?.id ?? null,
        action: payload.action,
        eventKey,
        error: serializeError(error),
      });

      sendText(response, isRetryableDispatchError(error) ? 503 : 500, "Dispatch failed");
      return;
    } finally {
      inFlightEventKeys.delete(eventKey);
    }
    logger.info("linear_thenvoi_bridge.webhook_dispatched", {
      sessionId: payload.agentSession.id,
      issueId: payload.agentSession.issue?.id ?? null,
      action: payload.action,
      eventKey,
    });

    sendText(response, 200, "OK");
  };
}

function normalizeAction(action: string | null | undefined): string {
  return typeof action === "string" ? action.trim().toLowerCase() : "";
}

function getHeaderValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return typeof value === "string" ? value : null;
}

async function readRawBody(request: NodeRequestWithBody): Promise<Buffer> {
  if (Buffer.isBuffer(request.body)) {
    return request.body;
  }

  if (typeof request.body === "string") {
    return Buffer.from(request.body);
  }

  if (request.body instanceof Uint8Array) {
    return Buffer.from(request.body);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
  }
  return Buffer.concat(chunks);
}

function sendText(response: ServerResponse, statusCode: number, body: string): void {
  if (response.headersSent) {
    return;
  }

  response.statusCode = statusCode;
  response.end(body);
}

async function runDispatchAttempt(
  task: () => Promise<void>,
  context: {
    logger: Logger;
    failureEvent: string;
    retryEvent: string;
    eventKey: string;
    sessionId: string;
    retryLimit?: number;
    retryBaseDelayMs?: number;
  },
): Promise<DispatchAttemptResult> {
  const retryLimit = context.retryLimit ?? DISPATCH_RETRY_LIMIT;
  const retryBaseDelayMs = context.retryBaseDelayMs ?? DISPATCH_RETRY_BASE_DELAY_MS;
  let attempt = 0;

  while (true) {
    try {
      await task();
      return { ok: true };
    } catch (error) {
      if (!isRetryableDispatchError(error) || attempt >= retryLimit) {
        context.logger.error(context.failureEvent, {
          eventKey: context.eventKey,
          sessionId: context.sessionId,
          error: serializeError(error),
        });
        return {
          ok: false,
          attempts: attempt + 1,
          error,
        };
      }

      attempt += 1;
      context.logger.warn(context.retryEvent, {
        eventKey: context.eventKey,
        sessionId: context.sessionId,
        attempt,
        delayMs: retryBaseDelayMs * attempt,
        error: serializeError(error),
      });
      await sleep(retryBaseDelayMs * attempt);
    }
  }
}

async function markBootstrapHandoffProcessed(input: {
  eventKey: string;
  store: HandleAgentSessionEventInput["deps"]["store"];
  logger: Logger;
  sessionId: string;
}): Promise<void> {
  try {
    await input.store.markBootstrapRequestProcessed(input.eventKey);
  } catch (error) {
    input.logger.warn("linear_thenvoi_bridge.bootstrap_handoff_mark_processed_failed", {
      eventKey: input.eventKey,
      sessionId: input.sessionId,
      error: serializeError(error),
    });
  }
}

async function signalTerminalDispatchFailure(input: {
  logger: Logger;
  job: LinearBridgeDispatchJob;
  failure: DispatchTerminalFailure;
}): Promise<void> {
  const { logger, job, failure } = input;

  try {
    const existing = await job.input.deps.store.getBySessionId(failure.sessionId);
    if (existing) {
      await job.input.deps.store.upsert({
        ...existing,
        status: "errored",
        lastEventKey: job.eventKey,
        updatedAt: new Date().toISOString(),
      });
      logger.warn("linear_thenvoi_bridge.async_dispatch_terminal_failure_signaled", {
        eventKey: failure.eventKey,
        sessionId: failure.sessionId,
        attempts: failure.attempts,
        signal: "session_store_status_errored",
      });
      return;
    }
  } catch (storeError) {
    logger.error("linear_thenvoi_bridge.async_dispatch_terminal_failure_store_signal_failed", {
      eventKey: failure.eventKey,
      sessionId: failure.sessionId,
      attempts: failure.attempts,
      dispatchError: serializeError(failure.error),
      signalError: serializeError(storeError),
    });
  }

  try {
    await postError(
      job.input.deps.linearClient,
      failure.sessionId,
      "Bridge dispatch failed and could not recover automatically. Retry this session event in Linear.",
    );
    logger.warn("linear_thenvoi_bridge.async_dispatch_terminal_failure_signaled", {
      eventKey: failure.eventKey,
      sessionId: failure.sessionId,
      attempts: failure.attempts,
      signal: "linear_activity_error",
    });
  } catch (signalError) {
    logger.error("linear_thenvoi_bridge.async_dispatch_terminal_failure_signal_failed", {
      eventKey: failure.eventKey,
      sessionId: failure.sessionId,
      attempts: failure.attempts,
      dispatchError: serializeError(failure.error),
      signalError: serializeError(signalError),
    });
  }
}

function isRetryableDispatchError(error: unknown): error is { retryable: true } {
  return typeof error === "object" && error !== null && "retryable" in error && (error as { retryable?: boolean }).retryable === true;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(typeof (error as { retryable?: unknown }).retryable !== "undefined"
        ? { retryable: (error as { retryable?: unknown }).retryable }
        : {}),
    };
  }

  return {
    message: String(error),
  };
}

function toDispatchFailureError(failure: DispatchTerminalFailure): Error {
  return new Error(
    `Linear bridge async dispatch failed for event ${failure.eventKey} (session ${failure.sessionId})`,
    { cause: failure.error },
  );
}
