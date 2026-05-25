import { ThenvoiLink } from "@thenvoi/sdk";
import {
  ContactEventHandler,
  HUB_ROOM_SYSTEM_PROMPT,
  RoomPresence,
} from "@thenvoi/sdk/runtime";
import type { ContactEvent, PlatformEvent } from "@thenvoi/sdk";
import type { BoundedStringSet } from "./bounded-string-set.js";
import { resolveAccountCredentials, type ThenvoiAccountConfig } from "./config.js";
import {
  buildOpenClawBody,
  messageInsertedAt,
  messageMentionsAgent,
  platformEventToInboundMessage,
  type OpenClawInboundMessage,
} from "./message-utils.js";
import type { OpenClawRuntimeDispatch } from "./openclaw-runtime.js";
import { createBandReplyDispatcher, createNoopReplyDispatcher } from "./reply-dispatcher.js";
import { redactSecrets } from "./redaction.js";

const CONTACTS_THREAD_ID = "__thenvoi_contacts__";
const ROOM_RECOVERY_SWEEP_INTERVAL_MS = 10_000;
const STARTUP_MESSAGE_GRACE_MS = 5_000;

export interface GatewayContext {
  cfg: unknown;
  accountId: string;
  account: ThenvoiAccountConfig;
  abortSignal: AbortSignal;
}

export interface GatewayHelpers {
  startAccount: (ctx: GatewayContext) => Promise<void>;
  stopAccount: (ctx: GatewayContext) => Promise<void>;
}

interface BandToolEventContext {
  accountId: string;
  roomId: string;
}

interface GatewayRuntimeOptions {
  links: Map<string, ThenvoiLink>;
  presences: Map<string, RoomPresence>;
  startingAccounts: Set<string>;
  processedMessageIds: BoundedStringSet;
  getOpenClawRuntime: () => OpenClawRuntimeDispatch | null;
  createLogger: (accountId: string) => ConstructorParameters<typeof RoomPresence>[0]["logger"];
  deliverMessage: (message: OpenClawInboundMessage, accountId?: string) => void;
  trackSender: (accountId: string, threadId: string, senderId: string, senderName: string, senderType?: string) => void;
  resolveFinalReplyMentions: (rest: ThenvoiLink["rest"], agentId: string, accountId: string, roomId: string) => Promise<Array<{ id: string; name?: string }>>;
  runWithBandToolEventContext: <T>(context: BandToolEventContext, fn: () => Promise<T>) => Promise<T>;
}

export function createGatewayHelpers(options: GatewayRuntimeOptions): GatewayHelpers {
  return {
    startAccount: async (ctx: GatewayContext): Promise<void> => {
      const { accountId, account: accountConfig } = ctx;

      if (options.startingAccounts.has(accountId)) {
        console.warn(`[thenvoi:${accountId}] startAccount already in progress, skipping`);
        return;
      }
      options.startingAccounts.add(accountId);

      try {
        console.log(`[thenvoi:${accountId}] Starting gateway...`);
        const accountStartedAt = Date.now();

        if (options.links.has(accountId)) {
          console.log(`[thenvoi:${accountId}] Disconnecting previous connection before restart...`);
          const existingPresence = options.presences.get(accountId);
          if (existingPresence) {
            await existingPresence.stop();
            options.presences.delete(accountId);
          }
          const existingLink = options.links.get(accountId);
          if (existingLink) {
            await existingLink.disconnect();
          }
          options.links.delete(accountId);
        }

        const config = resolveAccountCredentials(accountConfig);
        const logger = options.createLogger(accountId);
        const link = new ThenvoiLink({
          agentId: config.agentId,
          apiKey: config.apiKey,
          wsUrl: config.wsUrl,
          restUrl: config.restUrl,
          logger,
        });
        options.links.set(accountId, link);
        console.log(`[thenvoi:${accountId}] Link created`);

        await link.connect();
        console.log(`[thenvoi:${accountId}] WebSocket connected`);

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
          if (dedupeKey && options.processedMessageIds.has(dedupeKey)) return;

          const message = platformEventToInboundMessage(event);
          if (!message) return;

          if (roomId && messageId) {
            try {
              await link.markProcessing(roomId, messageId, { bestEffort: true });
            } catch {
              // Best effort - don't fail if marking fails
            }
          }

          let handled = false;
          let failure: unknown;
          const dispatch = options.getOpenClawRuntime();
          if (dispatch) {
            try {
              if (message.threadId && message.senderId && message.senderName) {
                options.trackSender(accountId, message.threadId, message.senderId, message.senderName, message.senderType);
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
                  () => options.resolveFinalReplyMentions(link.rest, link.agentId, accountId, message.threadId),
                );

              console.log(`[thenvoi:${accountId}] Dispatching message to OpenClaw agent...`);
              const cfg = dispatch.loadConfig();
              await options.runWithBandToolEventContext(bandTurnContext, async () => dispatch.dispatchReplyFromConfig({
                ctx: inboundCtx,
                cfg,
                dispatcher,
              }));
              await dispatcher.waitForIdle();
              handled = true;
              console.log(`[thenvoi:${accountId}] Message dispatched successfully`);
            } catch (error) {
              failure = error;
              console.error(`[thenvoi:${accountId}] Failed to dispatch message: ${redactSecrets(error)}`);
            }
          } else {
            options.deliverMessage(message, accountId);
            handled = true;
          }

          if (roomId && messageId) {
            if (handled) {
              try {
                await link.markProcessed(roomId, messageId, { bestEffort: true });
              } catch {
                // Best effort - don't fail if marking fails
              }
              if (dedupeKey) options.processedMessageIds.add(dedupeKey);
            } else {
              try {
                await link.markFailed(roomId, messageId, redactSecrets(failure), { bestEffort: true });
              } catch {
                // Best effort - don't fail if marking fails
              }
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
                console.warn(`[thenvoi:${accountId}] Failed to fetch pending message for room ${roomId}; retrying on the next recovery sweep: ${redactSecrets(error)}`);
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

        presence.onRoomJoined = async (roomId: string, payload: Record<string, unknown>) => {
          const title = (payload.title as string) ?? roomId;
          console.log(`[thenvoi:${accountId}] Joined room: ${title} (${roomId})`);
          await catchUpMentionedMessages(roomId);
        };

        presence.onRoomLeft = async (roomId: string) => {
          console.log(`[thenvoi:${accountId}] Left room: ${roomId}`);
        };

        presence.onRoomEvent = async (_roomId: string, event: PlatformEvent) => {
          await handleMessageEvent(event);
        };

        const contactConfig = accountConfig.contactConfig ?? { strategy: "disabled" };
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

              const dispatch = options.getOpenClawRuntime();
              if (!dispatch) {
                options.deliverMessage(message, accountId);
                return;
              }

              const hubTurnContext: BandToolEventContext = { accountId, roomId: hubRoomId };
              const dispatcher = createBandReplyDispatcher(
                link,
                accountId,
                hubRoomId,
                () => options.resolveFinalReplyMentions(link.rest, link.agentId, accountId, hubRoomId),
              );
              const cfg = dispatch.loadConfig();
              await options.runWithBandToolEventContext(hubTurnContext, async () => dispatch.dispatchReplyFromConfig({
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

        presence.onContactEvent = async (event: ContactEvent) => {
          if (!contactHandler) return;
          try {
            console.log(`[thenvoi:${accountId}] Contact event: ${event.type}`);
            await contactHandler.handle(event);
          } catch (error) {
            console.error(`[thenvoi:${accountId}] Failed to handle contact event: ${redactSecrets(error)}`);
          }
        };

        options.presences.set(accountId, presence);
        await presence.start();
        console.log(`[thenvoi:${accountId}] Connected to Band platform`);

        if (!ctx.abortSignal.aborted) {
          await new Promise<void>((resolve) => {
            ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        }

        console.log(`[thenvoi:${accountId}] Shutdown signal received`);
      } finally {
        options.startingAccounts.delete(accountId);
      }
    },

    stopAccount: async (ctx: GatewayContext): Promise<void> => {
      const { accountId } = ctx;
      options.startingAccounts.delete(accountId);

      const presence = options.presences.get(accountId);
      if (presence) {
        await presence.stop();
        options.presences.delete(accountId);
      }

      const link = options.links.get(accountId);
      if (link) {
        await link.disconnect();
        options.links.delete(accountId);
      }

      console.log(`[thenvoi:${accountId}] Disconnected from Band platform`);
    },
  };
}
