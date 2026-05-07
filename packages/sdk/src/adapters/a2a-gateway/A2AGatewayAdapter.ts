import { randomUUID } from "node:crypto";

import { SimpleAdapter } from "../../core/simpleAdapter";
import { UnsupportedFeatureError, ValidationError } from "../../core/errors";
import type { PeerRecord } from "../../contracts/dtos";
import type { MessagingTools } from "../../contracts/protocols";
import type { ChatMessageMention } from "../../client/rest/types";
import type { PlatformMessage } from "../../runtime/types";
import { asNonEmptyString } from "../shared/coercion";
import { GatewayHistoryConverter } from "./history";
import { createGatewayServer } from "./server";
import { buildStatusEvent } from "./statusEvent";
import type {
  A2AGatewayAdapterOptions,
  GatewayA2AMessage,
  GatewayA2AStatusUpdateEvent,
  GatewayCancelRequest,
  GatewayPeer,
  GatewayRequest,
  GatewayServerFactory,
  GatewaySessionState,
  GatewayTaskState,
  PendingA2ATask,
} from "./types";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 10_000;
const DEFAULT_GATEWAY_URL = `http://localhost:${DEFAULT_PORT}`;
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_PEER_PAGE_SIZE = 100;
const DEFAULT_MAX_PEER_PAGES = 25;

interface PendingTaskRecord extends PendingA2ATask {
  readonly strictTaskMetadata: boolean;
  requireTaskMetadata: boolean;
  readonly queue: AsyncEventQueue<GatewayA2AStatusUpdateEvent>;
}

export class A2AGatewayAdapter
  extends SimpleAdapter<GatewaySessionState, MessagingTools>
{
  private readonly thenvoiRest: A2AGatewayAdapterOptions["thenvoiRest"];
  private readonly gatewayUrl: string;
  private readonly host: string;
  private readonly port: number;
  private readonly authToken?: string;
  private readonly allowUnauthenticatedLoopback: boolean;
  private readonly responseTimeoutMs: number;
  private readonly peerPageSize: number;
  private readonly maxPeerPages: number;
  private readonly serverFactory: GatewayServerFactory;

  private readonly peersBySlug = new Map<string, GatewayPeer>();
  private readonly peersById = new Map<string, GatewayPeer>();
  private readonly contextToRoom = new Map<string, string>();
  private readonly roomParticipants = new Map<string, Set<string>>();
  private readonly pendingByRoom = new Map<string, Map<string, PendingTaskRecord>>();
  private readonly pendingByTask = new Map<string, PendingTaskRecord>();

  private server: ReturnType<GatewayServerFactory> | null = null;

  public constructor(options: A2AGatewayAdapterOptions) {
    super({
      historyConverter: new GatewayHistoryConverter(),
    });

    this.thenvoiRest = options.thenvoiRest;
    this.gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.authToken = options.authToken;
    this.allowUnauthenticatedLoopback = options.allowUnauthenticatedLoopback ?? false;
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.peerPageSize = options.peerPageSize ?? DEFAULT_PEER_PAGE_SIZE;
    this.maxPeerPages = options.maxPeerPages ?? DEFAULT_MAX_PEER_PAGES;
    this.serverFactory = options.serverFactory ?? createGatewayServer;

    if (this.allowUnauthenticatedLoopback && !isLoopbackHost(this.host)) {
      throw new ValidationError(
        "A2AGatewayAdapter `allowUnauthenticatedLoopback` may only be enabled for loopback hosts.",
      );
    }
  }

  public async onStarted(
    agentName: string,
    agentDescription: string,
  ): Promise<void> {
    await super.onStarted(agentName, agentDescription);
    await this.refreshPeers();

    this.server = this.serverFactory({
      peersBySlug: this.peersBySlug,
      peersById: this.peersById,
      gatewayUrl: this.gatewayUrl,
      host: this.host,
      port: this.port,
      authToken: this.authToken,
      allowUnauthenticatedLoopback: this.allowUnauthenticatedLoopback,
      onRequest: (request) => this.handleGatewayRequest(request),
      onCancel: async (request) => {
        const canonicalPeerId = this.resolveCanonicalPeerId(request);
        this.cancelPendingTask(request.taskId, canonicalPeerId ?? request.peerId);
      },
    });

    await this.server.start();
  }

  public async onMessage(
    message: PlatformMessage,
    _tools: MessagingTools,
    history: GatewaySessionState,
    _participantsMessage: string | null,
    _contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    if (context.isSessionBootstrap) {
      this.rehydrate(history);
    }

    const pending = this.resolvePendingForMessage(context.roomId, message);
    if (!pending) {
      return;
    }

    const event = toStatusUpdateEvent(message, pending.taskId, pending.contextId);
    pending.enqueue(event);

    if (event.final) {
      this.removePending(pending);
    }
  }

  public async onCleanup(roomId: string): Promise<void> {
    const roomPendings = this.pendingByRoom.get(roomId);
    if (roomPendings && roomPendings.size > 0) {
      for (const pending of roomPendings.values()) {
        pending.queue.cancel();
      }
      roomPendings.clear();
      this.pendingByRoom.delete(roomId);
    }

    for (const [taskId, pending] of this.pendingByTask) {
      if (pending.roomId === roomId) {
        this.pendingByTask.delete(taskId);
      }
    }

    this.forgetRoom(roomId);
  }

  public async stopGatewayServer(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    await server.stop();
  }

  public async onRuntimeStop(): Promise<void> {
    this.resetState();
    await this.stopGatewayServer();
  }

  private async refreshPeers(): Promise<void> {
    this.peersBySlug.clear();
    this.peersById.clear();
    if (!this.thenvoiRest.listPeers) {
      throw new UnsupportedFeatureError(
        "Peer listing is not available in current REST adapter",
      );
    }

    for (let page = 1; page <= this.maxPeerPages; page += 1) {
      const response = await this.thenvoiRest.listPeers({
        page,
        pageSize: this.peerPageSize,
        notInChat: "",
      });

      const peers = Array.isArray(response.data)
        ? response.data
        : [];

      for (const item of peers) {
        const peer = toGatewayPeer(item);
        if (!peer) {
          continue;
        }

        const slug = uniqueSlug(peer.slug, this.peersBySlug);
        const normalized: GatewayPeer = {
          ...peer,
          slug,
        };

        this.peersBySlug.set(slug, normalized);
        this.peersById.set(normalized.id, normalized);
      }

      if (peers.length < this.peerPageSize) {
        break;
      }
    }
  }

  private async *handleGatewayRequest(
    request: GatewayRequest,
  ): AsyncGenerator<GatewayA2AStatusUpdateEvent, void, undefined> {
    const peer = this.resolveGatewayPeer(request);
    if (!peer) {
      yield buildStatusEvent({
        taskId: request.taskId,
        contextId: request.contextId,
        state: "failed",
        final: true,
        text: `Peer not found: ${request.peerId}`,
      });
      return;
    }

    const hadContext = request.contextId.length > 0 && this.contextToRoom.has(request.contextId);
    const [roomId, contextId] = await this.getOrCreateRoom(
      request.contextId,
      peer.id,
    );

    const roomPendings = this.pendingByRoom.get(roomId);
    const activeInRoom = roomPendings?.size ?? 0;
    const queue = new AsyncEventQueue<GatewayA2AStatusUpdateEvent>();
    const strictTaskMetadata = hadContext;
    const pending: PendingTaskRecord = {
      taskId: request.taskId,
      contextId,
      peerId: peer.id,
      peerSlug: peer.slug,
      roomId,
      strictTaskMetadata,
      requireTaskMetadata: strictTaskMetadata || activeInRoom > 0,
      queue,
      enqueue: (event) => {
        queue.enqueue(event);
      },
    };

    this.registerPending(pending);
    this.pendingByTask.set(pending.taskId, pending);

    yield buildStatusEvent({
      taskId: pending.taskId,
      contextId: pending.contextId,
      state: "working",
      final: false,
      text: `Routed request to ${peer.name}.`,
    });

    try {
      await this.emitContextEvent(roomId, contextId);

      const content = extractMessageText(request.message) ?? "";
      await this.thenvoiRest.createChatMessage(roomId, {
        content: buildMentionedContent(peer.name, content),
        mentions: buildMentions(peer),
      });
    } catch (error) {
      this.removePending(pending);
      yield buildStatusEvent({
        taskId: pending.taskId,
        contextId: pending.contextId,
        state: "failed",
        final: true,
        text: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    while (true) {
      const next = await pending.queue.dequeue(this.responseTimeoutMs);
      if (!next) {
        this.removePending(pending);
        yield buildStatusEvent({
          taskId: pending.taskId,
          contextId: pending.contextId,
          state: "failed",
          final: true,
          text: "Timed out waiting for a Thenvoi peer response.",
        });
        return;
      }

      yield next;

      if (next.final) {
        this.removePending(pending);
        return;
      }
    }
  }

  private cancelPendingTask(taskId: string, peerId: string): void {
    const pending = this.pendingByTask.get(taskId);
    if (!pending) {
      return;
    }

    // Enqueue a terminal event so the generator yields it before closing.
    this.finalizePending(
      pending,
      buildStatusEvent({
        taskId,
        contextId: pending.contextId,
        state: "canceled",
        final: true,
        text: `Task canceled by A2A client (${peerId}).`,
      }),
    );
  }

  private registerPending(pending: PendingTaskRecord): void {
    const roomPendings = this.pendingByRoom.get(pending.roomId) ?? new Map<string, PendingTaskRecord>();
    roomPendings.set(pending.taskId, pending);
    this.pendingByRoom.set(pending.roomId, roomPendings);

    if (roomPendings.size > 1) {
      for (const entry of roomPendings.values()) {
        entry.requireTaskMetadata = true;
      }
    }
  }

  private resolvePendingForMessage(
    roomId: string,
    message: PlatformMessage,
  ): PendingTaskRecord | null {
    const roomPendings = this.pendingByRoom.get(roomId);
    if (!roomPendings || roomPendings.size === 0) {
      return null;
    }

    const metadata = message.metadata ?? {};
    const gatewayTaskId = asNonEmptyString(metadata.gateway_task_id);
    if (gatewayTaskId) {
      const pending = roomPendings.get(gatewayTaskId) ?? null;
      if (!pending || !shouldRouteToPendingTask(message, pending)) {
        return null;
      }

      return pending;
    }

    let matched: PendingTaskRecord | null = null;
    for (const pending of roomPendings.values()) {
      if (!shouldRouteToPendingTask(message, pending)) {
        continue;
      }

      if (matched) {
        return null;
      }

      matched = pending;
    }

    return matched;
  }

  private resolveGatewayPeer(
    request: Pick<GatewayRequest, "peerId" | "peerSlug">,
  ): GatewayPeer | null {
    const canonicalPeerId = this.resolveCanonicalPeerId(request);
    if (!canonicalPeerId) {
      return null;
    }

    return this.peersById.get(canonicalPeerId) ?? null;
  }

  private resolveCanonicalPeerId(
    request: Pick<GatewayRequest, "peerId" | "peerSlug">
      | Pick<GatewayCancelRequest, "peerId" | "peerSlug">,
  ): string | null {
    // Canonical contract is peerId=Thenvoi peer id; keep legacy slug aliasing at this edge.
    const byId = this.peersById.get(request.peerId);
    if (byId) {
      return byId.id;
    }

    const legacySlug = request.peerSlug ?? request.peerId;
    const bySlug = this.peersBySlug.get(legacySlug);
    if (bySlug) {
      return bySlug.id;
    }

    return null;
  }

  private async getOrCreateRoom(
    contextId: string,
    targetPeerId: string,
  ): Promise<[string, string]> {
    const existingRoom = this.contextToRoom.get(contextId);
    if (existingRoom) {
      const participants = this.roomParticipants.get(existingRoom) ?? new Set<string>();
      if (!participants.has(targetPeerId)) {
        await this.thenvoiRest.addChatParticipant(existingRoom, {
          participantId: targetPeerId,
          role: "member",
        });
        participants.add(targetPeerId);
        this.roomParticipants.set(existingRoom, participants);
      }

      return [existingRoom, contextId];
    }

    const normalizedContextId = contextId && contextId.length > 0 ? contextId : randomUUID();
    // Thenvoi's createChat task_id field is validated as a UUID. A2A contexts
    // aren't Thenvoi tasks, so don't masquerade the context id as one — leave
    // task_id unset and track context↔room mapping in memory below.
    const created = await this.thenvoiRest.createChat();
    const roomId = created.id;

    await this.thenvoiRest.addChatParticipant(roomId, {
      participantId: targetPeerId,
      role: "member",
    });

    this.contextToRoom.set(normalizedContextId, roomId);
    this.roomParticipants.set(roomId, new Set<string>([targetPeerId]));

    return [roomId, normalizedContextId];
  }

  private async emitContextEvent(roomId: string, contextId: string): Promise<void> {
    await this.thenvoiRest.createChatEvent(roomId, {
      content: "A2A gateway context",
      messageType: "task",
      metadata: {
        gateway_context_id: contextId,
        gateway_room_id: roomId,
      },
    });
  }

  private rehydrate(history: GatewaySessionState): void {
    for (const [contextId, roomId] of Object.entries(history.contextToRoom)) {
      if (!this.contextToRoom.has(contextId)) {
        this.contextToRoom.set(contextId, roomId);
      }
    }

    for (const [roomId, peers] of Object.entries(history.roomParticipants)) {
      const existing = this.roomParticipants.get(roomId) ?? new Set<string>();
      for (const peer of peers) {
        existing.add(peer);
      }
      this.roomParticipants.set(roomId, existing);
    }
  }

  private removePending(pending: PendingTaskRecord): void {
    const roomPendings = this.pendingByRoom.get(pending.roomId);
    if (roomPendings) {
      roomPendings.delete(pending.taskId);
      if (roomPendings.size === 0) {
        this.pendingByRoom.delete(pending.roomId);
      } else {
        const hasMultiple = roomPendings.size > 1;
        for (const entry of roomPendings.values()) {
          entry.requireTaskMetadata = entry.strictTaskMetadata || hasMultiple;
        }
      }
    }

    const byTask = this.pendingByTask.get(pending.taskId);
    if (byTask === pending) {
      this.pendingByTask.delete(pending.taskId);
    }
  }

  private finalizePending(
    pending: PendingTaskRecord,
    event: GatewayA2AStatusUpdateEvent,
  ): void {
    pending.queue.clear();
    pending.enqueue(event);
    this.removePending(pending);
  }

  private forgetRoom(roomId: string): void {
    this.roomParticipants.delete(roomId);

    for (const [contextId, mappedRoomId] of this.contextToRoom.entries()) {
      if (mappedRoomId === roomId) {
        this.contextToRoom.delete(contextId);
      }
    }
  }

  private resetState(): void {
    for (const pending of this.pendingByTask.values()) {
      pending.queue.cancel();
    }

    this.peersBySlug.clear();
    this.peersById.clear();
    this.contextToRoom.clear();
    this.roomParticipants.clear();
    this.pendingByRoom.clear();
    this.pendingByTask.clear();
  }
}

class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T | null) => void> = [];
  private cancelled = false;

  public enqueue(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }

    this.items.push(item);
  }

  public cancel(): void {
    this.cancelled = true;
    this.items.length = 0;
    const pending = this.waiters.splice(0);
    for (const waiter of pending) {
      waiter(null);
    }
  }

  public clear(): void {
    this.items.length = 0;
  }

  public async dequeue(timeoutMs: number): Promise<T | null> {
    if (this.cancelled) {
      return null;
    }

    if (this.items.length > 0) {
      return this.items.shift() ?? null;
    }

    return new Promise<T | null>((resolve) => {
      const waiter = (value: T | null): void => {
        clearTimeout(timeout);
        resolve(value);
      };

      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        resolve(null);
      }, timeoutMs);

      this.waiters.push(waiter);
    });
  }
}

function toGatewayPeer(value: Record<string, unknown> | PeerRecord): GatewayPeer | null {
  const id = asNonEmptyString(value.id);
  if (!id) {
    return null;
  }

  const name = asNonEmptyString(value.name) ?? asNonEmptyString(value.handle) ?? id;
  const description = asNonEmptyString(value.description) ?? "";
  const handle = asNonEmptyString(value.handle);

  return {
    id,
    name,
    description,
    handle,
    slug: slugify(handle ?? name),
  };
}

function uniqueSlug(
  baseSlug: string,
  existing: Map<string, GatewayPeer>,
): string {
  if (!existing.has(baseSlug)) {
    return baseSlug;
  }

  let index = 2;
  while (existing.has(`${baseSlug}-${index}`)) {
    index += 1;
  }

  return `${baseSlug}-${index}`;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "peer";
}

function buildMentionedContent(peerName: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return `@${peerName}`;
  }

  return `@${peerName} ${trimmed}`;
}

function buildMentions(peer: GatewayPeer): ChatMessageMention[] {
  if (peer.handle) {
    return [{ id: peer.id, handle: peer.handle }];
  }

  return [{ id: peer.id }];
}

function toStatusUpdateEvent(
  message: PlatformMessage,
  taskId: string,
  contextId: string,
): GatewayA2AStatusUpdateEvent {
  const normalizedType = message.messageType.trim().toLowerCase();

  let state: GatewayTaskState;
  let final = false;

  if (normalizedType === "error") {
    state = "failed";
    final = true;
  } else if (normalizedType === "text") {
    state = "completed";
    final = true;
  } else {
    state = "working";
  }

  return buildStatusEvent({
    taskId,
    contextId,
    state,
    final,
    text: message.content,
    metadata: {
      thenvoi_message_id: message.id,
      thenvoi_message_type: message.messageType,
      thenvoi_sender_id: message.senderId,
      thenvoi_room_id: message.roomId,
    },
  });
}

function shouldRouteToPendingTask(
  message: PlatformMessage,
  pending: PendingTaskRecord,
): boolean {
  const metadata = message.metadata ?? {};
  const gatewayTaskId = asNonEmptyString(metadata.gateway_task_id);
  if (gatewayTaskId) {
    return gatewayTaskId === pending.taskId;
  }

  if (pending.requireTaskMetadata) {
    return false;
  }

  const gatewayContextId = asNonEmptyString(metadata.gateway_context_id);
  if (gatewayContextId && gatewayContextId !== pending.contextId) {
    return false;
  }

  const gatewayPeerId = asNonEmptyString(metadata.gateway_peer_id);
  if (gatewayPeerId) {
    return peerMatchesPendingIdentifier(gatewayPeerId, pending);
  }

  const gatewayPeerSlug = asNonEmptyString(metadata.gateway_peer_slug);
  if (gatewayPeerSlug) {
    return gatewayPeerSlug === pending.peerSlug;
  }

  return peerMatchesPendingIdentifier(message.senderId, pending);
}

function peerMatchesPendingIdentifier(
  identifier: string,
  pending: PendingTaskRecord,
): boolean {
  return identifier === pending.peerId || identifier === pending.peerSlug;
}

function extractMessageText(message: GatewayA2AMessage): string | null {
  const chunks: string[] = [];

  for (const part of message.parts) {
    if (typeof part.text === "string" && part.text.trim().length > 0) {
      chunks.push(part.text.trim());
      continue;
    }

    if (
      part.root &&
      typeof part.root.text === "string" &&
      part.root.text.trim().length > 0
    ) {
      chunks.push(part.root.text.trim());
    }
  }

  if (chunks.length === 0) {
    return null;
  }

  return chunks.join("\n");
}
