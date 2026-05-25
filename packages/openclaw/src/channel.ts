/**
 * Band Channel Plugin for OpenClaw.
 *
 * Registers the Band channel with OpenClaw Gateway,
 * enabling bidirectional communication with Band.
 *
 * Uses @thenvoi/sdk for all platform communication (WebSocket + REST).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { ThenvoiLink } from "@thenvoi/sdk";
import {
  RoomPresence,
  ContactEventHandler,
  HUB_ROOM_SYSTEM_PROMPT,
} from "@thenvoi/sdk/runtime";
import type { ContactEventConfig, ContactEvent, PlatformEvent } from "@thenvoi/sdk";
import { BoundedStringSet } from "./bounded-string-set.js";
import {
  buildOpenClawBody,
  messageInsertedAt,
  messageMentionsAgent,
  platformEventToInboundMessage,
  type OpenClawInboundMessage,
} from "./message-utils.js";
import { resolveOpenClawRuntimeDispatch, type OpenClawRuntimeDispatch } from "./openclaw-runtime.js";
import { createBandReplyDispatcher, createNoopReplyDispatcher } from "./reply-dispatcher.js";
import { redactSecrets } from "./redaction.js";

export type { OpenClawInboundMessage } from "./message-utils.js";

// =============================================================================
// OpenClaw-Specific Types
// =============================================================================

export interface ThenvoiAccountConfig {
  enabled?: boolean;
  apiKey?: string;
  agentId?: string;
  wsUrl?: string;
  restUrl?: string;
  contactConfig?: ContactEventConfig;
  operatorId?: string;
}

// =============================================================================
// Types for OpenClaw Plugin API
// =============================================================================

interface OpenClawChannelApi {
  registerChannel: (options: { plugin: OpenClawChannel }) => void;
}

interface OpenClawChannel {
  id: string;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigHelpers;
  outbound: OutboundAdapter;
  setup?: SetupHelpers;
  gateway?: GatewayHelpers;
  threading?: ThreadingHelpers;
  messaging?: MessagingHelpers;
}

interface ChannelMeta {
  id: string;
  label: string;
  selectionLabel: string;
  docsPath: string;
  blurb: string;
  aliases: string[];
}

interface ChannelCapabilities {
  chatTypes: ("direct" | "group")[];
  features?: string[];
}

interface ChannelConfigHelpers {
  listAccountIds: (config: PluginConfig) => string[];
  resolveAccount: (config: PluginConfig, accountId?: string) => ThenvoiAccountConfig;
}

interface OutboundContext {
  cfg: unknown;
  to: string;
  text: string;
  mediaUrl?: string;
  threadId?: string | number | null;
  accountId?: string | null;
}

interface OutboundDeliveryResult {
  channel: string;
  messageId: string;
  chatId?: string;
  roomId?: string;
}

interface OutboundAdapter {
  deliveryMode: "direct" | "queued";
  resolveTarget?: (params: { to?: string; allowFrom?: string[]; mode?: string }) => { ok: true; to: string } | { ok: false; error: Error };
  sendText: (ctx: OutboundContext) => Promise<OutboundDeliveryResult>;
  sendMedia: (ctx: OutboundContext) => Promise<OutboundDeliveryResult>;
}

interface SetupHelpers {
  validateConfig?: (config: ThenvoiAccountConfig) => Promise<ValidationResult>;
}

interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

interface GatewayContext {
  cfg: unknown;
  accountId: string;
  account: ThenvoiAccountConfig;
  abortSignal: AbortSignal;
}

interface GatewayHelpers {
  startAccount: (ctx: GatewayContext) => Promise<void>;
  stopAccount: (ctx: GatewayContext) => Promise<void>;
}

interface ThreadingHelpers {
  extractThreadId: (message: OpenClawInboundMessage) => string;
  formatThreadContext?: (threadId: string) => string;
}

interface MessagingHelpers {
  normalizeTarget?: (raw: string) => string | undefined;
  targetResolver?: {
    looksLikeId?: (raw: string, normalized?: string) => boolean;
    hint?: string;
  };
}

interface PluginConfig {
  channels?: {
    thenvoi?: {
      accounts?: Record<string, ThenvoiAccountConfig>;
    };
    "openclaw-channel-thenvoi"?: {
      accounts?: Record<string, ThenvoiAccountConfig>;
    };
  };
  plugins?: {
    entries?: {
      thenvoi?: {
        config?: {
          accounts?: Record<string, ThenvoiAccountConfig>;
        };
      };
      "openclaw-channel-thenvoi"?: {
        config?: {
          accounts?: Record<string, ThenvoiAccountConfig>;
        };
      };
    };
  };
}

// =============================================================================
// Virtual thread ID for contact events (dispatched to LLM for evaluation)
// =============================================================================

const CONTACTS_THREAD_ID = "__thenvoi_contacts__";
const ROOM_RECOVERY_SWEEP_INTERVAL_MS = 10_000;
const STARTUP_MESSAGE_GRACE_MS = 5_000;

// =============================================================================
// Channel State
// =============================================================================

// Global registry to track gateway state across module reloads.
// All mutable state lives here so it survives Jiti reloading the module.
// The key is versioned so that two different package versions loaded in
// the same process do not silently share (and corrupt) each other's state.
//
// __OPENCLAW_PKG_VERSION__ is replaced at build time by tsup (see tsup.config.ts `define`).
// At dev/test time it falls back to reading package.json so the version is
// never hardcoded in source.
declare const __OPENCLAW_PKG_VERSION__: string;
function resolvePackageVersion(): string {
  if (typeof __OPENCLAW_PKG_VERSION__ !== "undefined") return __OPENCLAW_PKG_VERSION__;
  try {
    // Dev / test fallback: read from package.json via Node's fs
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const pkgPath = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgPath), "utf-8")) as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0-dev";
  }
}
const PKG_VERSION: string = resolvePackageVersion();
const GATEWAY_REGISTRY_KEY = `__thenvoi_gateway_registry_v${PKG_VERSION}__`;
const toolEventContext = new AsyncLocalStorage<BandToolEventContext>();
export interface BandToolEventContext {
  accountId: string;
  roomId: string;
  sentMessage?: boolean;
}

interface GatewayRegistry {
  links: Map<string, ThenvoiLink>;
  presences: Map<string, RoomPresence>;
  startingAccounts: Set<string>;
  lastSenderByThread: Map<string, { senderId: string; senderName: string; senderType?: string }>;
  replyOwnerByThread: Map<string, { senderId: string; senderName: string }>;
  processedMessageIds: BoundedStringSet;
  deliverInbound: ((message: OpenClawInboundMessage) => void) | null;
  openclawRuntime: OpenClawRuntimeDispatch | null;
}

function getGatewayRegistry(): GatewayRegistry {
  const g = globalThis as unknown as Record<string, GatewayRegistry>;
  if (!g[GATEWAY_REGISTRY_KEY]) {
    g[GATEWAY_REGISTRY_KEY] = {
      links: new Map(),
      presences: new Map(),
      startingAccounts: new Set(),
      lastSenderByThread: new Map(),
      replyOwnerByThread: new Map(),
      processedMessageIds: new BoundedStringSet(MAX_MESSAGE_DEDUPE_CACHE),
      deliverInbound: null,
      openclawRuntime: null,
    };
  }
  return g[GATEWAY_REGISTRY_KEY];
}

/**
 * Reset the gateway registry to its initial state.
 * Intended for test isolation — call in beforeEach/afterEach to prevent state leaking between tests.
 */
export function resetGatewayRegistry(): void {
  const g = globalThis as unknown as Record<string, GatewayRegistry>;
  delete g[GATEWAY_REGISTRY_KEY];
}

// Convenience accessors that always read from the current registry.
// These MUST be functions (not module-level consts) so that
// resetGatewayRegistry() properly invalidates cached state.
function registry(): GatewayRegistry { return getGatewayRegistry(); }
function links(): Map<string, ThenvoiLink> { return getGatewayRegistry().links; }
function presences(): Map<string, RoomPresence> { return getGatewayRegistry().presences; }

export function getBandToolEventContext(): BandToolEventContext | undefined {
  return toolEventContext.getStore();
}

export function recordBandMessageSentForCurrentTurn(): void {
  const context = toolEventContext.getStore();
  if (context) context.sentMessage = true;
}

function runWithBandToolEventContext<T>(context: BandToolEventContext, fn: () => Promise<T>): Promise<T> {
  return toolEventContext.run(context, fn);
}

function formatLogContext(context?: Record<string, unknown>): string {
  if (!context) return "";
  try {
    return ` ${redactSecrets(JSON.stringify(context))}`;
  } catch {
    return ` ${redactSecrets(context)}`;
  }
}

function createChannelLogger(accountId: string) {
  return {
    debug: (message: string, context?: Record<string, unknown>): void => {
      console.debug(`[thenvoi:${accountId}] ${message}${formatLogContext(context)}`);
    },
    info: (message: string, context?: Record<string, unknown>): void => {
      console.log(`[thenvoi:${accountId}] ${message}${formatLogContext(context)}`);
    },
    warn: (message: string, context?: Record<string, unknown>): void => {
      console.warn(`[thenvoi:${accountId}] ${message}${formatLogContext(context)}`);
    },
    error: (message: string, context?: Record<string, unknown>): void => {
      console.error(`[thenvoi:${accountId}] ${message}${formatLogContext(context)}`);
    },
  };
}

// Track last sender per thread for auto-mention fallback
// Key: threadId, Value: { senderId, senderName }
const MAX_SENDER_CACHE = 500;
const MAX_MESSAGE_DEDUPE_CACHE = 2_000;

function trackSender(accountId: string, threadId: string, senderId: string, senderName: string, senderType?: string): void {
  const lastSenderByThread = registry().lastSenderByThread;
  const cacheKey = `${accountId}:${threadId}`;
  // Delete-and-reinsert to move the entry to the end (LRU eviction order)
  lastSenderByThread.delete(cacheKey);
  if (lastSenderByThread.size >= MAX_SENDER_CACHE) {
    // Evict least-recently-used entry (first key in Map insertion order)
    const oldest = lastSenderByThread.keys().next().value;
    if (oldest) lastSenderByThread.delete(oldest);
  }
  lastSenderByThread.set(cacheKey, { senderId, senderName, senderType });

  if (senderType?.toLowerCase() !== "agent") {
    const replyOwnerByThread = registry().replyOwnerByThread;
    replyOwnerByThread.delete(cacheKey);
    if (replyOwnerByThread.size >= MAX_SENDER_CACHE) {
      const oldest = replyOwnerByThread.keys().next().value;
      if (oldest) replyOwnerByThread.delete(oldest);
    }
    replyOwnerByThread.set(cacheKey, { senderId, senderName });
  }
}

/**
 * Set the OpenClaw runtime reference for message dispatch.
 * Called by the plugin entry point.
 */
export function setOpenClawRuntime(runtime: unknown): void {
  const resolution = resolveOpenClawRuntimeDispatch(runtime);
  registry().openclawRuntime = resolution.dispatch;

  if (resolution.dispatch) {
    console.log("[thenvoi] OpenClaw dispatch methods available");
  } else {
    console.warn(`[thenvoi] OpenClaw dispatch unavailable: ${resolution.reason ?? "unknown runtime shape"}`);
  }
}

/**
 * Set the gateway callback for delivering inbound messages.
 * Called by OpenClaw when the channel is started.
 */
export function setInboundCallback(
  callback: (message: OpenClawInboundMessage) => void,
): void {
  registry().deliverInbound = callback;
}

/**
 * Deliver an inbound message to OpenClaw.
 * Used by the service and runtime to send received messages to OpenClaw.
 */
export function deliverMessage(message: OpenClawInboundMessage, accountId: string = "default"): void {
  // Track the sender for auto-mention fallback when responding
  if (message.threadId && message.senderId && message.senderName) {
    trackSender(accountId, message.threadId, message.senderId, message.senderName, message.senderType);
  }

  const deliver = registry().deliverInbound;
  if (deliver) {
    deliver(message);
  } else {
    console.warn("[thenvoi] Cannot deliver message: no inbound callback set");
  }
}

// =============================================================================
// Configuration Helpers
// =============================================================================

function resolveEnvBackedValue(value: string | undefined, envName: string): string | undefined {
  return value && value !== `\${${envName}}` ? value : process.env[envName];
}

function resolveConfig(account: ThenvoiAccountConfig): { apiKey: string; agentId: string; wsUrl: string; restUrl: string } {
  const apiKey = resolveEnvBackedValue(account.apiKey, "THENVOI_API_KEY");
  const agentId = resolveEnvBackedValue(account.agentId, "THENVOI_AGENT_ID");
  const wsUrl = resolveEnvBackedValue(account.wsUrl, "THENVOI_WS_URL") ?? "wss://app.band.ai/api/v1/socket";
  const restUrl = resolveEnvBackedValue(account.restUrl, "THENVOI_REST_URL") ?? "https://app.band.ai";

  if (!apiKey) {
    throw new Error("THENVOI_API_KEY is required");
  }
  if (!agentId) {
    throw new Error("THENVOI_AGENT_ID is required");
  }

  return { apiKey, agentId, wsUrl, restUrl };
}

// =============================================================================
// Mention Resolution
// =============================================================================

type Mention = { id: string; name?: string };

/**
 * Resolve mentions for a message: find @Name in text, fall back to last sender, then any participant.
 * Returns null if no participants are available to mention (caller decides how to handle).
 */
async function resolveMentions(
  rest: ThenvoiLink["rest"],
  agentId: string,
  accountId: string,
  roomId: string,
  text: string,
): Promise<{ mentions: Mention[]; participants: Array<{ id: string; name: string }> } | null> {
  const participants = await rest.listChatParticipants(roomId);

  // 1. Explicit @Name mentions in text (case-insensitive)
  const mentioned: Mention[] = [];
  const textLower = text.toLowerCase();
  for (const p of participants) {
    if (p.id !== agentId && textLower.includes(`@${p.name.toLowerCase()}`)) {
      mentioned.push({ id: p.id, name: p.name });
    }
  }
  if (mentioned.length > 0) return { mentions: mentioned, participants };

  // 2. Fallback: last sender in this thread
  const lastSender = registry().lastSenderByThread.get(`${accountId}:${roomId}`);
  if (lastSender) {
    const senderParticipant = participants.find(
      (p) => p.id === lastSender.senderId && p.id !== agentId
    );
    if (senderParticipant) {
      return { mentions: [{ id: senderParticipant.id, name: senderParticipant.name }], participants };
    }
  }

  // 3. Fallback: first other participant
  const other = participants.find((p) => p.id !== agentId);
  if (other) {
    return { mentions: [{ id: other.id, name: other.name }], participants };
  }

  return null;
}

// =============================================================================
// Reply Helper
// =============================================================================

async function resolveFinalReplyMentions(
  rest: ThenvoiLink["rest"],
  agentId: string,
  accountId: string,
  roomId: string,
): Promise<Mention[]> {
  const participants = await rest.listChatParticipants(roomId);
  const cacheKey = `${accountId}:${roomId}`;

  const replyOwner = registry().replyOwnerByThread.get(cacheKey);
  if (replyOwner) {
    const participant = participants.find((p) => p.id === replyOwner.senderId && p.id !== agentId);
    if (participant) return [{ id: participant.id, name: participant.name }];
  }

  const ownerLikeParticipant = participants.find((p) => p.id !== agentId && p.type?.toLowerCase() !== "agent");
  if (ownerLikeParticipant) return [{ id: ownerLikeParticipant.id, name: ownerLikeParticipant.name }];

  const lastSender = registry().lastSenderByThread.get(cacheKey);
  if (lastSender) {
    const participant = participants.find((p) => p.id === lastSender.senderId && p.id !== agentId);
    if (participant) return [{ id: participant.id, name: participant.name }];
  }

  const otherParticipant = participants.find((p) => p.id !== agentId);
  if (otherParticipant) return [{ id: otherParticipant.id, name: otherParticipant.name }];

  throw new Error("Cannot send final reply: no other participant is available to mention");
}

// =============================================================================
// Outbound Send Helper
// =============================================================================

/**
 * Shared logic for sending an outbound message (text or media) to Band.
 */
async function sendOutbound(ctx: OutboundContext): Promise<OutboundDeliveryResult> {
  const { text, to, accountId } = ctx;
  const roomId = to;

  if (!roomId) {
    throw new Error("room_id is required");
  }

  const link = links().get(accountId ?? "default");
  if (!link) {
    throw new Error("Band link not initialized");
  }

  const resolved = await resolveMentions(link.rest, link.agentId, accountId ?? "default", roomId, text);
  if (!resolved) {
    throw new Error("Cannot send message: no other participants to mention");
  }

  const result = await link.rest.createChatMessage(roomId, { content: text, mentions: resolved.mentions });

  return {
    channel: "thenvoi",
    messageId: String(result.id ?? `thenvoi-${Date.now()}`),
    roomId,
  };
}

// =============================================================================
// Channel Definition
// =============================================================================

export const thenvoiChannel: OpenClawChannel = {
  id: "openclaw-channel-thenvoi",

  meta: {
    id: "openclaw-channel-thenvoi",
    label: "Band",
    selectionLabel: "Band (AI Collaboration)",
    docsPath: "/channels/thenvoi",
    blurb: "Connect to the Band AI agent collaboration platform.",
    aliases: ["thenvoi", "openclaw-channel-thenvoi"],
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    features: ["threading", "mentions"],
  },

  config: {
    listAccountIds: (config: PluginConfig): string[] => {
      const pluginAccounts = config.plugins?.entries?.["openclaw-channel-thenvoi"]?.config?.accounts
        ?? config.plugins?.entries?.thenvoi?.config?.accounts ?? {};
      const channelAccounts = config.channels?.["openclaw-channel-thenvoi"]?.accounts
        ?? config.channels?.thenvoi?.accounts ?? {};
      const accounts = { ...pluginAccounts, ...channelAccounts };
      return Object.keys(accounts);
    },

    resolveAccount: (
      config: PluginConfig,
      accountId?: string,
    ): ThenvoiAccountConfig => {
      const pluginAccounts = config.plugins?.entries?.["openclaw-channel-thenvoi"]?.config?.accounts
        ?? config.plugins?.entries?.thenvoi?.config?.accounts ?? {};
      const channelAccounts = config.channels?.["openclaw-channel-thenvoi"]?.accounts
        ?? config.channels?.thenvoi?.accounts ?? {};
      const accounts = { ...pluginAccounts, ...channelAccounts };
      const account = accounts[accountId ?? "default"] ?? { enabled: true };
      return account;
    },
  },

  outbound: {
    deliveryMode: "direct",

    resolveTarget: (params: { to?: string; allowFrom?: string[]; mode?: string }) => {
      const target = params.to?.trim() ?? "";
      if (!target) {
        return { ok: false, error: new Error("Band requires a room_id as target") };
      }
      return { ok: true, to: target };
    },

    sendText: (ctx: OutboundContext): Promise<OutboundDeliveryResult> => {
      return sendOutbound(ctx);
    },

    sendMedia: (ctx: OutboundContext): Promise<OutboundDeliveryResult> => {
      const messageText = ctx.mediaUrl ? `${ctx.text}\n\n${ctx.mediaUrl}` : ctx.text;
      return sendOutbound({ ...ctx, text: messageText });
    },
  },

  setup: {
    validateConfig: async (
      config: ThenvoiAccountConfig,
    ): Promise<ValidationResult> => {
      let testLink: ThenvoiLink | null = null;
      try {
        const resolved = resolveConfig(config);

        // Test connection by creating a temporary link and fetching agent metadata
        testLink = new ThenvoiLink({
          agentId: resolved.agentId,
          apiKey: resolved.apiKey,
          wsUrl: resolved.wsUrl,
          restUrl: resolved.restUrl,
        });
        await testLink.rest.getAgentMe();

        return { valid: true };
      } catch (error) {
        return { valid: false, errors: [redactSecrets(error)] };
      } finally {
        if (testLink) {
          try { await testLink.disconnect(); } catch { /* ignore cleanup errors */ }
        }
      }
    },
  },

  gateway: {
    startAccount: async (ctx: GatewayContext): Promise<void> => {
      const { accountId, account: accountConfig } = ctx;

      // Prevent concurrent startAccount calls for the same account
      if (registry().startingAccounts.has(accountId)) {
        console.warn(`[thenvoi:${accountId}] startAccount already in progress, skipping`);
        return;
      }
      registry().startingAccounts.add(accountId);

      try {
        console.log(`[thenvoi:${accountId}] Starting gateway...`);
        const accountStartedAt = Date.now();

        // Disconnect any existing connection to prevent orphaned connections on reload
        if (links().has(accountId)) {
          console.log(`[thenvoi:${accountId}] Disconnecting previous connection before restart...`);
          const existingPresence = presences().get(accountId);
          if (existingPresence) {
            await existingPresence.stop();
            presences().delete(accountId);
          }
          const existingLink = links().get(accountId);
          if (existingLink) {
            await existingLink.disconnect();
          }
          links().delete(accountId);
        }

        const config = resolveConfig(accountConfig);
        const logger = createChannelLogger(accountId);

        // Create ThenvoiLink (combines WebSocket + REST)
        const link = new ThenvoiLink({
          agentId: config.agentId,
          apiKey: config.apiKey,
          wsUrl: config.wsUrl,
          restUrl: config.restUrl,
          logger,
        });
        links().set(accountId, link);
        console.log(`[thenvoi:${accountId}] Link created`);

        // Connect WebSocket
        await link.connect();
        console.log(`[thenvoi:${accountId}] WebSocket connected`);

        // Create RoomPresence for automatic room subscription management
        const presence = new RoomPresence({
          link,
          autoSubscribeExistingRooms: true,
          recoverySweepIntervalMs: ROOM_RECOVERY_SWEEP_INTERVAL_MS,
          logger,
        });

        async function handleMessageEvent(event: PlatformEvent): Promise<void> {
          if (event.type !== "message_created") return;
          if (event.payload.sender_id === config.agentId) return;

          const messageId = event.payload.id;
          const roomId = event.roomId ?? event.payload.chat_room_id;
          const dedupeKey = roomId && messageId ? `${accountId}:${roomId}:${messageId}` : undefined;
          if (dedupeKey && registry().processedMessageIds.has(dedupeKey)) return;
          if (dedupeKey) registry().processedMessageIds.add(dedupeKey);

          const message = platformEventToInboundMessage(event);
          if (!message) return;

          if (roomId && messageId) {
            try {
              await link.markProcessing(roomId, messageId, { bestEffort: true });
            } catch {
              // Best effort - don't fail if marking fails
            }
          }

          const dispatch = registry().openclawRuntime;
          if (dispatch) {
            try {
              if (message.threadId && message.senderId && message.senderName) {
                trackSender(accountId, message.threadId, message.senderId, message.senderName, message.senderType);
              }

              const body = buildOpenClawBody(message);
              const inboundCtx = {
                Body: body,
                RawBody: body,
                BodyForCommands: body,
                CommandBody: body,
                From: message.senderId,
                SenderId: message.senderId,
                SenderName: message.senderName,
                SenderType: message.senderType,
                To: message.threadId,
                SessionKey: `thenvoi:${message.threadId}`,
                Surface: "thenvoi",
                Provider: "thenvoi",
                MessageSid: (message.metadata as Record<string, unknown>)?.messageId,
                Timestamp: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
                ChatType: "group",
                CommandAuthorized: true,
                BandOperatorId: accountConfig.operatorId,
              };

              const bandTurnContext: BandToolEventContext = { accountId, roomId: message.threadId };
              const dispatcher = message.threadId === CONTACTS_THREAD_ID
                ? createNoopReplyDispatcher()
                : createBandReplyDispatcher(
                  link,
                  accountId,
                  message.threadId,
                  () => resolveFinalReplyMentions(link.rest, link.agentId, accountId, message.threadId),
                  bandTurnContext,
                );

              console.log(`[thenvoi:${accountId}] Dispatching message to OpenClaw agent...`);
              const cfg = dispatch.loadConfig();
              await runWithBandToolEventContext(bandTurnContext, async () => dispatch.dispatchReplyFromConfig({
                ctx: inboundCtx,
                cfg,
                dispatcher,
              }));
              await dispatcher.waitForIdle();
              console.log(`[thenvoi:${accountId}] Message dispatched successfully`);
            } catch (error) {
              console.error(`[thenvoi:${accountId}] Failed to dispatch message: ${redactSecrets(error)}`);
            }
          } else {
            deliverMessage(message, accountId);
          }

          if (roomId && messageId) {
            try {
              await link.markProcessed(roomId, messageId, { bestEffort: true });
            } catch {
              // Best effort - don't fail if marking fails
            }
          }
        }

        async function catchUpMentionedMessages(roomId: string): Promise<void> {
          if (typeof link.rest.getNextMessage === "function") {
            const seenPendingIds = new Set<string>();
            for (let drained = 0; drained < 25; drained += 1) {
              let next;
              try {
                next = await link.rest.getNextMessage({ chatId: roomId });
              } catch (error) {
                console.warn(`[thenvoi:${accountId}] Failed to fetch pending message for room ${roomId}; pruning room from local tracking: ${redactSecrets(error)}`);
                presence.rooms.delete(roomId);
                try { await link.unsubscribeRoom(roomId); } catch { /* best effort */ }
                return;
              }
              if (!next) break;
              if (seenPendingIds.has(next.id)) {
                console.warn(`[thenvoi:${accountId}] Pending message ${next.id} repeated for room ${roomId}; stopping catch-up drain`);
                break;
              }
              seenPendingIds.add(next.id);

              const insertedAt = messageInsertedAt(next as unknown as Record<string, unknown>);
              if (!insertedAt || insertedAt < accountStartedAt - STARTUP_MESSAGE_GRACE_MS) {
                console.log(`[thenvoi:${accountId}] Skipping stale pending message in room ${roomId}`);
                try { await link.markProcessing(roomId, next.id, { bestEffort: true }); } catch { /* best effort */ }
                try { await link.markProcessed(roomId, next.id, { bestEffort: true }); } catch { /* best effort */ }
                continue;
              }
              if (next.sender_id === config.agentId) {
                try { await link.markProcessing(roomId, next.id, { bestEffort: true }); } catch { /* best effort */ }
                try { await link.markProcessed(roomId, next.id, { bestEffort: true }); } catch { /* best effort */ }
                continue;
              }
              if (next.message_type !== "text") {
                try { await link.markProcessing(roomId, next.id, { bestEffort: true }); } catch { /* best effort */ }
                try { await link.markProcessed(roomId, next.id, { bestEffort: true }); } catch { /* best effort */ }
                continue;
              }
              console.log(`[thenvoi:${accountId}] Catching up pending mentioned message in room ${roomId}`);
              await handleMessageEvent({
                type: "message_created",
                roomId,
                payload: {
                  id: next.id,
                  chat_room_id: roomId,
                  sender_id: next.sender_id,
                  sender_type: next.sender_type,
                  sender_name: next.sender_name,
                  content: next.content,
                  message_type: next.message_type,
                  inserted_at: next.inserted_at,
                  metadata: next.metadata ?? {},
                },
              } as PlatformEvent);
            }
            return;
          }

          if (typeof link.rest.listMessages !== "function") return;
          const response = await link.rest.listMessages({ chatId: roomId, page: 1, pageSize: 10 });
          const messages = Array.isArray(response.data) ? response.data : [];
          for (const payload of ([...messages].reverse() as unknown as Record<string, unknown>[])) {
            if (payload.sender_id === config.agentId) continue;
            if (payload.message_type !== "text") continue;
            const insertedAt = messageInsertedAt(payload);
            if (!insertedAt || insertedAt < accountStartedAt - STARTUP_MESSAGE_GRACE_MS) continue;
            if (!messageMentionsAgent(payload, config.agentId)) continue;
            console.log(`[thenvoi:${accountId}] Catching up mentioned message in room ${roomId}`);
            await handleMessageEvent({ type: "message_created", roomId, payload } as PlatformEvent);
          }
        }

        // Set up room event handlers
        presence.onRoomJoined = async (roomId: string, payload: Record<string, unknown>) => {
          const title = (payload.title as string) ?? roomId;
          console.log(`[thenvoi:${accountId}] Joined room: ${title} (${roomId})`);
          await catchUpMentionedMessages(roomId);
        };

        presence.onRoomLeft = async (roomId: string) => {
          console.log(`[thenvoi:${accountId}] Left room: ${roomId}`);
        };

        // Handle room events (messages, participant changes)
        presence.onRoomEvent = async (_roomId: string, event: PlatformEvent) => {
          await handleMessageEvent(event);
        };

        const contactConfig = accountConfig.contactConfig ?? { strategy: "disabled" };

        // Create a singleton ContactEventHandler for this account when contact
        // event handling is enabled. Hub-room mode stays plugin-owned: contact
        // events become synthetic OpenClaw messages in the hub room, without
        // changing normal Band-room threading or OpenClaw routing semantics.
        const contactHandler = contactConfig.strategy && contactConfig.strategy !== "disabled"
          ? new ContactEventHandler({
            config: contactConfig,
            rest: link.rest,
            onBroadcast: (msg: string) => {
              console.log(`[thenvoi:${accountId}] Contact broadcast: ${msg}`);
            },
            onHubInit: async (hubRoomId: string, systemPrompt: string) => {
              await link.rest.createChatEvent(hubRoomId, {
                content: systemPrompt,
                messageType: "system",
                metadata: { source: "openclaw", prompt: HUB_ROOM_SYSTEM_PROMPT },
              });
            },
            onHubEvent: async (hubRoomId: string, event: PlatformEvent) => {
              const message = platformEventToInboundMessage({ ...event, roomId: hubRoomId } as PlatformEvent);
              if (!message) return;

              const dispatch = registry().openclawRuntime;
              if (!dispatch) {
                deliverMessage(message, accountId);
                return;
              }

              const dispatcher = createBandReplyDispatcher(
                link,
                accountId,
                hubRoomId,
                () => resolveFinalReplyMentions(link.rest, link.agentId, accountId, hubRoomId),
              );
              const cfg = dispatch.loadConfig();
              await runWithBandToolEventContext({ accountId, roomId: hubRoomId }, async () => dispatch.dispatchReplyFromConfig({
                ctx: {
                  Body: message.text,
                  RawBody: message.text,
                  BodyForCommands: message.text,
                  CommandBody: message.text,
                  From: message.senderId,
                  SenderId: message.senderId,
                  SenderName: message.senderName,
                  To: hubRoomId,
                  SessionKey: `thenvoi:${hubRoomId}`,
                  Surface: "thenvoi",
                  Provider: "thenvoi",
                  MessageSid: (message.metadata as Record<string, unknown>)?.messageId,
                  Timestamp: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
                  ChatType: "group",
                  CommandAuthorized: true,
                  BandContactHub: true,
                  BandOperatorId: accountConfig.operatorId,
                },
                cfg,
                dispatcher,
              }));
              await dispatcher.waitForIdle();
            },
          })
          : null;

        // Handle contact events when explicitly configured for this account.
        presence.onContactEvent = async (event: ContactEvent) => {
          if (!contactHandler) return;
          try {
            console.log(`[thenvoi:${accountId}] Contact event: ${event.type}`);
            await contactHandler.handle(event);
          } catch (error) {
            console.error(`[thenvoi:${accountId}] Failed to handle contact event: ${redactSecrets(error)}`);
          }
        };

        presences().set(accountId, presence);

        // Start the event loop
        await presence.start();

        console.log(`[thenvoi:${accountId}] Connected to Band platform`);

        // Block until OpenClaw signals shutdown — startAccount must stay
        // alive for the lifetime of the connection, otherwise OpenClaw
        // treats the exit as a failure and triggers auto-restart.
        if (!ctx.abortSignal.aborted) {
          await new Promise<void>((resolve) => {
            ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        }

        console.log(`[thenvoi:${accountId}] Shutdown signal received`);
      } finally {
        registry().startingAccounts.delete(accountId);
      }
    },

    stopAccount: async (ctx: GatewayContext): Promise<void> => {
      const { accountId } = ctx;
      registry().startingAccounts.delete(accountId);

      const presence = presences().get(accountId);
      if (presence) {
        await presence.stop();
        presences().delete(accountId);
      }

      const link = links().get(accountId);
      if (link) {
        await link.disconnect();
        links().delete(accountId);
      }

      console.log(`[thenvoi:${accountId}] Disconnected from Band platform`);
    },
  },

  threading: {
    extractThreadId: (message: OpenClawInboundMessage): string => {
      return message.threadId;
    },

    formatThreadContext: (threadId: string): string => {
      return `[Band Room: ${threadId}]`;
    },
  },

  messaging: {
    targetResolver: {
      // UUID pattern for Band room IDs
      looksLikeId: (raw: string): boolean => {
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return uuidPattern.test(raw.trim());
      },
      hint: "Provide a Band room_id (UUID format)",
    },
  },
};

// =============================================================================
// Plugin Registration
// =============================================================================

/**
 * Register the Band channel with OpenClaw.
 */
export function registerChannel(api: OpenClawChannelApi): void {
  api.registerChannel({ plugin: thenvoiChannel });
  console.log("[thenvoi] Channel registered");
}

// =============================================================================
// Utility Exports (for MCP tools)
// =============================================================================

/**
 * Get the ThenvoiLink for an account.
 */
export function getLink(accountId: string = "default"): ThenvoiLink | undefined {
  return links().get(accountId);
}

/**
 * Get the current agent's ID (UUID).
 */
export function getAgentId(accountId: string = "default"): string | undefined {
  return links().get(accountId)?.agentId;
}
