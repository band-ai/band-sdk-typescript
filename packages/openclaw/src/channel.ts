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
import type { RoomPresence } from "@thenvoi/sdk/runtime";
import { BoundedStringMap, BoundedStringSet } from "./bounded-string-set.js";
import {
  listAccountIds,
  resolveAccount,
  resolveAccountCredentials,
  type PluginConfig,
  type ThenvoiAccountConfig,
} from "./config.js";
import { createGatewayHelpers, type GatewayContext, type GatewayHelpers } from "./gateway.js";
import type { OpenClawInboundMessage } from "./message-utils.js";
import { resolveOpenClawRuntimeDispatch, type OpenClawRuntimeDispatch } from "./openclaw-runtime.js";
import { redactSecrets } from "./redaction.js";

export type { OpenClawInboundMessage } from "./message-utils.js";

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
}

interface GatewayRegistry {
  links: Map<string, ThenvoiLink>;
  presences: Map<string, RoomPresence>;
  startingAccounts: Set<string>;
  lastSenderByThread: BoundedStringMap<{ senderId: string; senderName: string; senderType?: string }>;
  replyOwnerByThread: BoundedStringMap<{ senderId: string; senderName: string }>;
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
      lastSenderByThread: new BoundedStringMap(MAX_SENDER_CACHE),
      replyOwnerByThread: new BoundedStringMap(MAX_SENDER_CACHE),
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

const MAX_SENDER_CACHE = 500;
const MAX_MESSAGE_DEDUPE_CACHE = 2_000;

function trackSender(accountId: string, threadId: string, senderId: string, senderName: string, senderType?: string): void {
  const cacheKey = `${accountId}:${threadId}`;
  registry().lastSenderByThread.set(cacheKey, { senderId, senderName, senderType });

  if (senderType?.toLowerCase() !== "agent") {
    registry().replyOwnerByThread.set(cacheKey, { senderId, senderName });
  }
}

export function setOpenClawRuntime(runtime: unknown): void {
  const resolution = resolveOpenClawRuntimeDispatch(runtime);
  registry().openclawRuntime = resolution.dispatch;

  if (resolution.dispatch) {
    console.log("[thenvoi] OpenClaw dispatch methods available");
  } else {
    console.warn(`[thenvoi] OpenClaw dispatch unavailable: ${resolution.reason ?? "unknown runtime shape"}`);
  }
}

export function setInboundCallback(
  callback: (message: OpenClawInboundMessage) => void,
): void {
  registry().deliverInbound = callback;
}

export function deliverMessage(message: OpenClawInboundMessage, accountId: string = "default"): void {
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

type Mention = { id: string; name?: string };

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

function gatewayHelpers(): GatewayHelpers {
  return createGatewayHelpers({
    links: links(),
    presences: presences(),
    startingAccounts: registry().startingAccounts,
    processedMessageIds: registry().processedMessageIds,
    getOpenClawRuntime: () => registry().openclawRuntime,
    createLogger: createChannelLogger,
    deliverMessage,
    trackSender,
    resolveFinalReplyMentions,
    runWithBandToolEventContext,
  });
}

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
    listAccountIds,
    resolveAccount,
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
        const resolved = resolveAccountCredentials(config);

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
    startAccount: (ctx: GatewayContext) => gatewayHelpers().startAccount(ctx),
    stopAccount: (ctx: GatewayContext) => gatewayHelpers().stopAccount(ctx),
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
      looksLikeId: (raw: string): boolean => {
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return uuidPattern.test(raw.trim());
      },
      hint: "Provide a Band room_id (UUID format)",
    },
  },
};

export function registerChannel(api: OpenClawChannelApi): void {
  api.registerChannel({ plugin: thenvoiChannel });
  console.log("[thenvoi] Channel registered");
}

export function getLink(accountId: string = "default"): ThenvoiLink | undefined {
  return links().get(accountId);
}

export function getAgentId(accountId: string = "default"): string | undefined {
  return links().get(accountId)?.agentId;
}
