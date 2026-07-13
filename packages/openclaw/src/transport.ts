/**
 * Band transport layer: owns the WebSocket connection lifecycle (ThenvoiLink +
 * AgentRuntime) and turns inbound Band platform events into OpenClaw inbound
 * contexts dispatched to core. `AgentRuntime` (one `Execution` per room) drains
 * the REST backlog on (re)connect, so messages sent while disconnected aren't
 * silently dropped.
 *
 * Invariants:
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
import { resolveConnectionConfig, DEFAULT_STOP_TIMEOUT_MS, type BandAccountConfig } from "./config.js";
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
  if (payload.sender_id === opts.selfAgentId) return null;
  if (payload.message_type !== "text") return null;

  const content = payload.content;
  const participants = opts.participants ?? [];
  const displayContent = replaceUuidMentions(content, participants);
  const roster = buildParticipantsBlock(participants, opts.selfAgentId);
  const withMarker = [displayContent, roster, `[Band Room: ${roomId}]`]
    .filter((part) => part.length > 0)
    .join("\n\n");

  const ctx: MsgContext = {
    // Room marker is a trailing SUFFIX so it can't collide with leading-@agent
    // strip or leading-/command parse.
    Body: withMarker,
    BodyForAgent: withMarker,
    // Command/parse fields stay RAW (no marker); RawBody is deprecated and
    // intentionally omitted.
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
    // Fail closed when the owner is unknown.
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
  markProcessing?: (roomId: string, messageId: string, opts?: { bestEffort?: boolean }) => Promise<unknown>;
}

interface RuntimeLike {
  start: () => Promise<unknown>;
  stop: (timeoutMs?: number) => Promise<unknown>;
}

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
}

/** Build the options object passed to `new AgentRuntime(...)`, pulled out as a
 * pure function so the `autoSubscribeExistingRooms` wiring can be tested
 * without constructing a real runtime. */
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

/** Build the reply `deliver` callback that routes a model reply payload to the
 * Band room. A delivery failure is logged, never thrown. */
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
      // Can disappear between dispatch and delivery (e.g. a teardown race on restart).
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
        onError: (err: unknown) => deps.log(`[band:${accountId}] reply error (room=${roomId}): ${String(err)}`),
      } as Parameters<typeof dispatchInboundMessageWithBufferedDispatcher>[0]["dispatcherOptions"],
    });
  };
}

/** Build the Band gateway adapter. Dependencies are injected so the lifecycle
 * is unit-testable with fakes. */
export function createBandGateway(deps: BandGatewayDeps = {}): ChannelGatewayAdapter<BandAccountConfig> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const createLink = deps.createLink ?? ((conn) => new ThenvoiLink(conn) as unknown as LinkLike);
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

  async function teardown(accountId: string): Promise<void> {
    const account = getAccount(accountId);
    if (!account) return;
    const runtime = account.runtime as RuntimeLike | undefined;
    try {
      if (runtime) await runtime.stop(account.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
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

      // A throw here would propagate through AgentRuntime's consumeLoop and
      // abort the whole account's live loop, same as in onExecute below.
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

      // Band's message status is sent -> processing -> processed; markProcessing
      // must be called before markProcessed. Not bestEffort: we want a REST
      // failure here to surface (via the catch below) rather than be silently
      // swallowed by ThenvoiLink's no-op logger, since a message that never
      // gets marked processed is redelivered from the backlog.
      async function markRoomMessageHandled(roomId: string, messageId: string): Promise<void> {
        if (link.markProcessing) {
          try {
            await link.markProcessing(roomId, messageId);
          } catch (err) {
            log(`[band:${accountId}] markProcessing failed (room=${roomId}, msg=${messageId}): ${String(err)}`);
          }
        }
        if (link.markProcessed) {
          try {
            await link.markProcessed(roomId, messageId);
          } catch (err) {
            log(`[band:${accountId}] markProcessed failed (room=${roomId}, msg=${messageId}): ${String(err)}`);
          }
        }
      }

      /** Filter + build the inbound context for a platform event; null means skip. */
      async function prepareInboundMessage(event: PlatformEvent): Promise<{
        ctx: MsgContext;
        roomId: string;
        messageId: string | undefined;
      } | null> {
        if (event.type !== "message_created") return null;
        const roomId = event.roomId ?? event.payload.chat_room_id;
        if (!roomId) return null;

        const roomType = getRoomType(accountId, roomId);
        if (roomType === undefined) {
          log(`[band:${accountId}] room ${roomId} has no cached type; defaulting ChatType to 'group'`);
        }

        // Best-effort: an empty roster on failure degrades to raw content.
        let participants: MentionParticipant[] = [];
        try {
          const list = (await link.rest.listChatParticipants?.(roomId)) ?? [];
          participants = list.map((p) => ({ id: p.id, name: p.name, handle: p.handle }));
        } catch (err) {
          log(`[band:${accountId}] could not list participants (room=${roomId}): ${String(err)}`);
        }

        const ctx = platformEventToInboundContext(event, {
          selfAgentId,
          ownerUuid,
          roomType,
          participants,
        });
        if (!ctx) return null; // self-authored / non-text skip

        if (event.payload.sender_id && event.payload.sender_name) {
          trackLastSender(accountId, roomId, {
            senderId: event.payload.sender_id,
            senderName: event.payload.sender_name,
          });
        }

        return { ctx, roomId, messageId: event.payload.id };
      }

      async function dispatchInbound(roomId: string, msgCtx: MsgContext): Promise<void> {
        try {
          await dispatch({ ctx: msgCtx, cfg: ctx.cfg, roomId, accountId });
        } catch (err) {
          log(`[band:${accountId}] dispatch failed (room=${roomId}): ${String(err)}`);
        }
      }

      // Must never throw: Execution.executeEvent rethrows, which aborts the
      // whole account's live-event consume loop.
      async function onExecute(_context: unknown, event: PlatformEvent): Promise<void> {
        try {
          const inbound = await prepareInboundMessage(event);
          if (!inbound) return;

          await dispatchInbound(inbound.roomId, inbound.ctx);

          if (inbound.messageId) {
            await markRoomMessageHandled(inbound.roomId, inbound.messageId);
          }
        } catch (err) {
          log(`[band:${accountId}] onExecute failed (room=${event.roomId ?? "?"}): ${String(err)}`);
        }
      }

      const runtime = createRuntime(link, { agentId: selfAgentId, onExecute, onRoomJoined, onContactEvent, onError });

      setAccount(accountId, {
        link: link as never,
        selfAgentId,
        ownerUuid,
        runtime: runtime as never,
        stopTimeoutMs: ctx.account.stopTimeoutMs,
      });

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
