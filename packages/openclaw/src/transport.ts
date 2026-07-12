/**
 * Band transport layer.
 *
 * This file owns the WebSocket connection lifecycle (ThenvoiLink + AgentRuntime)
 * and turns inbound Band platform events into OpenClaw inbound contexts that are
 * dispatched to core. The pure event->context mapping is split out as a testable
 * function; the live lifecycle (startAccount/stopAccount) is wired separately.
 *
 * Per INT-876: `AgentRuntime` (one `Execution` per room) replaces the bare
 * `RoomPresence`, so messages sent while disconnected are drained from the REST
 * backlog on (re)connect instead of being silently dropped — see PLAN-INT-876.md.
 *
 * Key INT-836 invariants encoded here (see REWRITE_PLAN D5/L2/F2):
 *  - the `[Band Room: <id>]` marker is a SUFFIX on the model-visible Body only;
 *    command fields stay RAW so stripMentions + command-parse aren't corrupted
 *  - ChatType is derived from the (cached) room type, default 'group'
 *  - CommandAuthorized = (senderId === ownerUuid), FAIL-CLOSED when no owner
 *  - SessionKey is the stable `band:{roomId}` (no chat_type/platform folding)
 */

import type { PlatformEvent, ContactEvent } from "@thenvoi/sdk";
import { ThenvoiLink } from "@thenvoi/sdk";
import { AgentRuntime, ContactEventHandler } from "@thenvoi/sdk/runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { dispatchInboundMessageWithBufferedDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { runPassiveAccountLifecycle } from "openclaw/plugin-sdk/channel-lifecycle";
import type {
  ChannelGatewayAdapter,
  ChannelGatewayContext,
} from "openclaw/plugin-sdk/channel-runtime";
import { resolveConnectionConfig, type BandAccountConfig } from "./config.js";
import { createProcessedStore as createDefaultProcessedStore, type ProcessedStore } from "./processed-store.js";
import {
  setAccount,
  deleteAccount,
  getAccount,
  cacheRoomType,
  getRoomType,
  trackLastSender,
  getLastSender,
} from "./state.js";
import { sendText as outboundSendText } from "./outbound.js";
import {
  replaceUuidMentions,
  buildParticipantsBlock,
  type MentionParticipant,
} from "./mentions.js";

export interface BuildInboundContextOptions {
  /** The agent's own id (self-authored messages are skipped). */
  selfAgentId: string;
  /** The agent owner's id; commands are authorized only for the owner. */
  ownerUuid?: string | null;
  /** The room's type (from the onRoomJoined cache); drives ChatType. */
  roomType?: string | null;
  /**
   * The room's participants. Used to rewrite Band's `@[[uuid]]` tokens into
   * readable `@handle` form and to inject a participant roster into the
   * model-facing body so the model addresses people by handle.
   */
  participants?: MentionParticipant[];
}

const DIRECT_ROOM_TYPES = new Set(["direct", "dm", "individual", "one_to_one"]);

/** Map a Band room type to OpenClaw's direct/group chat type (default group). */
export function roomTypeToChatType(roomType: string | null | undefined): "direct" | "group" {
  if (!roomType) return "group";
  return DIRECT_ROOM_TYPES.has(roomType.toLowerCase()) ? "direct" : "group";
}

/**
 * Convert a Band `message_created` event into the inbound context for dispatch.
 * Returns null for events that must not be dispatched (non-message, self-authored,
 * non-text, or roomless).
 */
export function platformEventToInboundContext(
  event: PlatformEvent,
  opts: BuildInboundContextOptions,
): MsgContext | null {
  if (event.type !== "message_created") return null;

  const payload = event.payload;
  const roomId = event.roomId ?? payload.chat_room_id;
  if (!roomId) return null;

  // Skip the agent's own messages and anything that isn't a plain text message.
  if (payload.sender_id === opts.selfAgentId) return null;
  if (payload.message_type !== "text") return null;

  const content = payload.content;
  // Model-facing body: rewrite Band's `@[[uuid]]` tokens to `@handle`, then append
  // a participant roster and the room marker. Command/parse fields below stay RAW.
  const participants = opts.participants ?? [];
  const displayContent = replaceUuidMentions(content, participants);
  const roster = buildParticipantsBlock(participants, opts.selfAgentId);
  const withMarker = [displayContent, roster, `[Band Room: ${roomId}]`]
    .filter((part) => part.length > 0)
    .join("\n\n");

  const ctx: MsgContext = {
    // Model-facing bodies carry the room marker as a trailing SUFFIX so it can't
    // collide with leading-@agent strip or leading-/command parse.
    Body: withMarker,
    BodyForAgent: withMarker,
    // Command/parse fields stay RAW (no marker) — core's stripMentions + command
    // parser operate on these. BodyForCommands is the preferred command field;
    // CommandBody is set too. (RawBody is deprecated — intentionally omitted.)
    BodyForCommands: content,
    CommandBody: content,
    From: payload.sender_id,
    SenderId: payload.sender_id,
    SenderName: payload.sender_name ?? "Unknown",
    To: roomId,
    SessionKey: `band:${roomId}`,
    Surface: "band",
    Provider: "band",
    MessageSid: payload.id,
    Timestamp: payload.inserted_at ? new Date(payload.inserted_at).getTime() : Date.now(),
    ChatType: roomTypeToChatType(opts.roomType),
    // Owner-only commands; fail closed when the owner is unknown.
    CommandAuthorized: opts.ownerUuid != null && payload.sender_id === opts.ownerUuid,
  };
  return ctx;
}

// =============================================================================
// Live account lifecycle (gateway.startAccount / stopAccount)
// =============================================================================

/** Minimal structural views of the SDK objects, so the lifecycle is testable. */
interface LinkLike {
  agentId: string;
  connect: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  rest: {
    getAgentMe: () => Promise<{ id: string; ownerUuid?: string | null }>;
    listChatParticipants?: (
      roomId: string,
    ) => Promise<Array<{ id: string; name: string; handle?: string | null }>>;
    [k: string]: unknown;
  };
  markProcessed?: (roomId: string, messageId: string, opts?: { bestEffort?: boolean }) => Promise<unknown>;
  /**
   * Band's message status is a state machine (sent -> processing -> processed);
   * `markProcessed` 422s if called directly from `sent` without first going
   * through `processing`. Required before `markProcessed` (see onExecute).
   */
  markProcessing?: (roomId: string, messageId: string, opts?: { bestEffort?: boolean }) => Promise<unknown>;
}

interface RuntimeLike {
  start: () => Promise<unknown>;
  stop: (timeoutMs?: number) => Promise<unknown>;
}

/** Finite teardown timeout for `runtime.stop()` (HIGH-2): an in-flight dispatch
 * awaiting the model must not be able to hang shutdown/restart indefinitely. */
const STOP_TIMEOUT_MS = 5_000;

interface DispatchParams {
  ctx: MsgContext;
  cfg: unknown;
  roomId: string;
  accountId: string;
}

/** Injectable dependencies (defaults use the real SDK + openclaw runtime). */
export interface BandGatewayDeps {
  createLink?: (conn: { agentId: string; apiKey: string; wsUrl: string; restUrl: string }) => LinkLike;
  createRuntime?: (
    link: LinkLike,
    opts: {
      agentId: string;
      onExecute: (context: unknown, event: PlatformEvent) => Promise<void>;
      onRoomJoined?: (roomId: string, payload: Record<string, unknown>) => unknown;
      onContactEvent?: (event: ContactEvent) => Promise<void>;
      onError?: (error: unknown, event: PlatformEvent) => void;
    },
  ) => RuntimeLike;
  createContactHandler?: (link: LinkLike) => { handle: (event: ContactEvent) => Promise<unknown> };
  dispatch?: (params: DispatchParams) => Promise<void>;
  runLifecycle?: (params: { abortSignal: AbortSignal; start: () => Promise<void>; stop: () => Promise<void> }) => Promise<void>;
  log?: (msg: string) => void;
  /**
   * Build the per-account dedup guard (see processed-store.ts) that stands in
   * for Band's unreliable server-side markProcessed cursor. Injectable so
   * tests use an in-memory fake instead of touching the real filesystem.
   */
  createProcessedStore?: (accountId: string, stateDir: string | undefined) => ProcessedStore;
}

/**
 * Build the plain options object passed to `new AgentRuntime(...)`. Pulled out
 * as a pure, directly-testable function (mirrors `platformEventToInboundContext`/
 * `createReplyDeliver`) so the `autoSubscribeExistingRooms` wiring (the actual
 * INT-876 fix) and the callback plumbing can be asserted without constructing a
 * real runtime.
 */
export function buildRuntimeOptions(
  link: LinkLike,
  opts: {
    agentId: string;
    onExecute: (context: unknown, event: PlatformEvent) => Promise<void>;
    onRoomJoined?: (roomId: string, payload: Record<string, unknown>) => unknown;
    onContactEvent?: (event: ContactEvent) => Promise<void>;
    onError?: (error: unknown, event: PlatformEvent) => void;
  },
) {
  return {
    link: link as never,
    agentId: opts.agentId,
    onExecute: opts.onExecute as never,
    onRoomJoined: opts.onRoomJoined,
    onContactEvent: opts.onContactEvent,
    onError: opts.onError,
    agentConfig: { autoSubscribeExistingRooms: true },
  };
}

// Module-scoped race guard: which accounts are mid-start.
const starting = new Set<string>();

/** For test isolation. */
export function resetGatewayStarting(): void {
  starting.clear();
}

/**
 * Build the reply `deliver` callback that routes a model reply payload to the
 * Band room via the outbound adapter. Exported so the deliver seam (the heart
 * of the inbound→reply round-trip) is unit-testable directly. A delivery
 * failure is logged (observable), never thrown.
 */
export function createReplyDeliver(
  accountId: string,
  roomId: string,
  log: (msg: string) => void,
): (payload: { text?: string } | string) => Promise<void> {
  return async (payload) => {
    const text = typeof payload === "string" ? payload : payload?.text;
    if (!text) return;
    const account = getAccount(accountId);
    if (!account) {
      // The account can disappear between dispatch and delivery (e.g. a teardown
      // race on restart). Log it — this function's contract is that delivery
      // failures are observable, never silently dropped.
      log(`[band:${accountId}] skipping reply (room=${roomId}): account not connected`);
      return;
    }
    try {
      await outboundSendText(
        {
          rest: account.link.rest as never,
          selfAgentId: account.selfAgentId,
          getLastSender: (r) => getLastSender(accountId, r) ?? null,
        },
        { to: roomId, text },
      );
    } catch (err) {
      log(`[band:${accountId}] reply delivery failed (room=${roomId}): ${String(err)}`);
    }
  };
}

function defaultDispatch(deps: Required<Pick<BandGatewayDeps, "log">>): (p: DispatchParams) => Promise<void> {
  return async ({ ctx, cfg, roomId, accountId }) => {
    await dispatchInboundMessageWithBufferedDispatcher({
      ctx,
      cfg: cfg as Parameters<typeof dispatchInboundMessageWithBufferedDispatcher>[0]["cfg"],
      dispatcherOptions: {
        deliver: createReplyDeliver(accountId, roomId, deps.log),
        // Observability: surface delivery/reply errors rather than dropping silently.
        onError: (err: unknown) => deps.log(`[band:${accountId}] reply error (room=${roomId}): ${String(err)}`),
      } as Parameters<typeof dispatchInboundMessageWithBufferedDispatcher>[0]["dispatcherOptions"],
    });
  };
}

/**
 * Build the Band gateway adapter. Dependencies are injected (defaults use the
 * real SDK + openclaw runtime) so the lifecycle is unit-testable with fakes.
 */
export function createBandGateway(deps: BandGatewayDeps = {}): ChannelGatewayAdapter<BandAccountConfig> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  // The SDK defaults to a NoopLogger, which silently swallows internal warnings
  // (e.g. a best-effort markProcessed failure) that are critical to diagnosing
  // backlog drain issues. Forward warn/error into the plugin's own observable
  // log; debug/info is per-topic-join connection chatter with no diagnostic
  // value here, so it's dropped rather than spamming the account's log.
  const sdkLogger = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, ctx?: Record<string, unknown>) => log(`[band:sdk][warn] ${msg}${ctx ? ` ${JSON.stringify(ctx)}` : ""}`),
    error: (msg: string, ctx?: Record<string, unknown>) => log(`[band:sdk][error] ${msg}${ctx ? ` ${JSON.stringify(ctx)}` : ""}`),
  };
  const createLink = deps.createLink ?? ((conn) => new ThenvoiLink({ ...conn, logger: sdkLogger }) as unknown as LinkLike);
  const createRuntime =
    deps.createRuntime ??
    ((link, opts) => new AgentRuntime(buildRuntimeOptions(link, opts) as never) as unknown as RuntimeLike);
  const createContactHandler =
    deps.createContactHandler ??
    ((link) =>
      new ContactEventHandler({
        config: { strategy: "hub_room", broadcastChanges: true },
        rest: link.rest as never,
      }) as unknown as { handle: (event: ContactEvent) => Promise<unknown> });
  const dispatch = deps.dispatch ?? defaultDispatch({ log });
  const createProcessedStore =
    deps.createProcessedStore ?? ((accountId, stateDir) => createDefaultProcessedStore(accountId, stateDir, log));

  async function teardown(accountId: string): Promise<void> {
    const account = getAccount(accountId);
    if (!account) return;
    const runtime = account.runtime as RuntimeLike | undefined;
    try {
      if (runtime) await runtime.stop(STOP_TIMEOUT_MS);
    } finally {
      try {
        await account.link.disconnect();
      } finally {
        deleteAccount(accountId);
      }
    }
  }

  async function startAccount(ctx: ChannelGatewayContext<BandAccountConfig>): Promise<void> {
    const accountId = ctx.accountId;

    // Race guard: ignore a concurrent start for the same account.
    if (starting.has(accountId)) {
      log(`[band:${accountId}] startAccount already in progress; skipping`);
      return;
    }
    starting.add(accountId);

    try {
      // Disconnect any prior connection before restarting.
      if (getAccount(accountId)) {
        log(`[band:${accountId}] disconnecting previous connection before restart`);
        await teardown(accountId);
      }

      const conn = resolveConnectionConfig(ctx.account);
      const link = createLink(conn);
      await link.connect();

      const me = await link.rest.getAgentMe();
      const selfAgentId = me.id ?? link.agentId;
      const ownerUuid = me.ownerUuid ?? null;

      const contactHandler = createContactHandler(link);
      const processedStore = createProcessedStore(accountId, ctx.account.stateDir);

      // Same failure class HIGH-1 fixed for onExecute: a throw here would propagate
      // through AgentRuntime's consumeLoop and abort the whole account's live loop.
      const onRoomJoined = (roomId: string, payload: Record<string, unknown>) => {
        try {
          const type = typeof payload?.type === "string" ? payload.type : undefined;
          if (type) cacheRoomType(accountId, roomId, type);
        } catch (err) {
          log(`[band:${accountId}] onRoomJoined failed (room=${roomId}): ${String(err)}`);
        }
      };

      const onContactEvent = async (event: ContactEvent) => {
        try {
          await contactHandler.handle(event);
        } catch (err) {
          log(`[band:${accountId}] contact event failed: ${String(err)}`);
        }
      };

      const onError = (error: unknown, event: PlatformEvent) => {
        log(`[band:${accountId}] fatal runtime error (room=${event.roomId ?? "?"}): ${String(error)}`);
      };

      // Band's message status is a state machine (sent -> processing -> processed);
      // markProcessed 422s if called directly from "sent" without going through
      // "processing" first (INT-876 root cause: onExecute previously only called
      // markProcessed, so the ack always failed, the server-side cursor never
      // advanced, and every reconnect's backlog drain got stuck re-redelivering
      // the same oldest message — starving anything sent after it). Both calls
      // are best-effort: a failure here must never block the room's next message.
      async function markRoomMessageHandled(roomId: string, messageId: string): Promise<void> {
        if (link.markProcessing) {
          try {
            await link.markProcessing(roomId, messageId, { bestEffort: true });
          } catch (err) {
            log(`[band:${accountId}] markProcessing failed (room=${roomId}, msg=${messageId}): ${String(err)}`);
          }
        }
        if (link.markProcessed) {
          try {
            await link.markProcessed(roomId, messageId, { bestEffort: true });
          } catch (err) {
            log(`[band:${accountId}] markProcessed failed (room=${roomId}, msg=${messageId}): ${String(err)}`);
          }
        }
      }

      // Per HIGH-1: `onExecute` must be TOTAL (never throw) — `Execution.executeEvent`
      // rethrows, which aborts the *whole account's* live-event consume loop. Everything
      // in the original `presence.onRoomEvent` body is wrapped in one top-level try/catch.
      async function onExecute(_context: unknown, event: PlatformEvent): Promise<void> {
        try {
          if (event.type !== "message_created") return;
          const roomId = event.roomId ?? event.payload.chat_room_id;
          if (!roomId) return;

          // Guard against re-dispatching (and re-answering) a message we've
          // already handled, using our own persisted record rather than trusting
          // the remote ack. Still (re-)attempt the processing/processed
          // transition: an older redelivered message may be the queue's stuck
          // head, and unblocking it is what lets later messages in the same
          // room surface at all.
          const messageId = event.payload.id;
          if (messageId && processedStore.has(messageId)) {
            log(`[band:${accountId}] skipping already-processed message ${messageId} (room=${roomId})`);
            await markRoomMessageHandled(roomId, messageId);
            return;
          }

          const roomType = getRoomType(accountId, roomId);
          if (roomType === undefined) {
            log(`[band:${accountId}] room ${roomId} has no cached type; defaulting ChatType to 'group'`);
          }

          // Fetch participants so the inbound body can rewrite `@[[uuid]]` tokens to
          // handles and carry a roster. Best-effort: an empty roster on failure
          // degrades to the prior behaviour (raw content), never blocks dispatch.
          let participants: MentionParticipant[] = [];
          try {
            const list = (await link.rest.listChatParticipants?.(roomId)) ?? [];
            participants = list.map((p) => ({ id: p.id, name: p.name, handle: p.handle }));
          } catch (err) {
            log(`[band:${accountId}] could not list participants (room=${roomId}): ${String(err)}`);
          }

          const msgCtx = platformEventToInboundContext(event, {
            selfAgentId,
            ownerUuid,
            roomType,
            participants,
          });
          if (!msgCtx) return; // self-authored / non-text skip

          if (event.payload.sender_id && event.payload.sender_name) {
            trackLastSender(accountId, roomId, {
              senderId: event.payload.sender_id,
              senderName: event.payload.sender_name,
            });
          }

          try {
            await dispatch({ ctx: msgCtx, cfg: ctx.cfg, roomId, accountId });
          } catch (err) {
            log(`[band:${accountId}] dispatch failed (room=${roomId}): ${String(err)}`);
          }

          if (messageId) {
            await markRoomMessageHandled(roomId, messageId);
          }

          // Record locally regardless of the remote ack's outcome — this is the
          // guard that actually prevents redelivery-driven duplicate replies.
          if (messageId) {
            try {
              await processedStore.markProcessed(messageId);
            } catch (err) {
              log(`[band:${accountId}] failed to persist processed marker (room=${roomId}, msg=${messageId}): ${String(err)}`);
            }
          }
        } catch (err) {
          log(`[band:${accountId}] onExecute failed (room=${event.roomId ?? "?"}): ${String(err)}`);
        }
      }

      const runtime = createRuntime(link, { agentId: selfAgentId, onExecute, onRoomJoined, onContactEvent, onError });

      setAccount(accountId, { link: link as never, selfAgentId, ownerUuid, runtime: runtime as never });

      await runtime.start();
      log(`[band:${accountId}] connected to Band`);

      // Hold the account open for its lifetime; tear down on abort.
      const runLifecycle = deps.runLifecycle ?? runPassiveAccountLifecycle;
      await runLifecycle({
        abortSignal: ctx.abortSignal,
        start: async () => {},
        stop: async () => {
          await teardown(accountId);
        },
      });
    } finally {
      starting.delete(accountId);
    }
  }

  async function stopAccount(ctx: ChannelGatewayContext<BandAccountConfig>): Promise<void> {
    starting.delete(ctx.accountId);
    await teardown(ctx.accountId);
    log(`[band:${ctx.accountId}] disconnected from Band`);
  }

  return { startAccount, stopAccount };
}
