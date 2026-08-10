import type { PaginatedResponse, RestApi } from "../../src/rest";
import type { ChatParticipant, PlatformChatMessage } from "../../src/client/rest/types";

interface ExamplePeer {
  id: string;
  name: string;
  handle: string;
}

interface CapturedRoomMessage {
  id?: string;
  roomId: string;
  content: string;
  senderId?: string;
  senderType?: string;
  senderName?: string;
  insertedAt?: string;
  messageType?: string;
  metadata?: Record<string, unknown>;
  mentions?: Array<{ id: string; handle?: string; name?: string; username?: string }>;
}

export class LinearBandExampleRestApi implements RestApi {
  public readonly peers: ExamplePeer[];
  public readonly roomMessages: CapturedRoomMessage[] = [];
  public readonly roomEvents: CapturedRoomMessage[] = [];
  public readonly createChatCalls: Array<string | undefined> = [];
  private readonly agentIdentity: {
    id: string;
    name: string;
    handle: string;
    description: string | null;
  };

  private readonly rooms = new Set<string>();
  private readonly roomParticipants = new Map<string, ChatParticipant[]>();
  private readonly roomMessagesByRoom = new Map<string, PlatformChatMessage[]>();
  private roomCounter = 0;
  private messageCounter = 0;

  public constructor(options?: {
    peers?: ExamplePeer[];
    agentId?: string;
    agentName?: string;
    agentHandle?: string;
  }) {
    const agentHandle = options?.agentHandle ?? "linear-host";
    const agentId = options?.agentId ?? "agent-linear-band";
    const agentName = options?.agentName ?? "Linear Band Host";

    this.peers = options?.peers ?? [
      { id: agentId, name: agentName, handle: agentHandle },
      { id: "peer-research", name: "research-agent", handle: "research-agent" },
      { id: "peer-synth", name: "synthesis-agent", handle: "synthesis-agent" },
    ];
    this.agentIdentity = {
      id: agentId,
      name: agentName,
      handle: agentHandle,
      description: "Example host agent for Linear + Band",
    };
  }

  public async getAgentMe() {
    return this.agentIdentity;
  }

  public async createChatMessage(
    chatId: string,
    message: {
      content: string;
      messageType?: string;
      metadata?: Record<string, unknown>;
      mentions?: Array<{ id: string; handle?: string; name?: string; username?: string }>;
    },
  ): Promise<Record<string, unknown>> {
    this.ensureRoom(chatId);
    const insertedAt = new Date().toISOString();
    const persisted: PlatformChatMessage = {
      id: `msg-${++this.messageCounter}`,
      content: message.content,
      sender_id: this.agentIdentity.id,
      sender_type: "Agent",
      sender_name: this.agentIdentity.name,
      message_type: message.messageType ?? "text",
      metadata: message.metadata ?? {},
      inserted_at: insertedAt,
      updated_at: insertedAt,
    };

    this.roomMessages.push({
      id: persisted.id,
      roomId: chatId,
      content: message.content,
      senderId: persisted.sender_id,
      senderType: persisted.sender_type,
      senderName: persisted.sender_name ?? this.agentIdentity.name,
      insertedAt,
      messageType: message.messageType,
      metadata: message.metadata,
      mentions: message.mentions,
    });
    const existing = this.roomMessagesByRoom.get(chatId) ?? [];
    existing.push(persisted);
    this.roomMessagesByRoom.set(chatId, existing);
    return { ok: true };
  }

  public async createChatEvent(
    chatId: string,
    event: {
      content: string;
      messageType: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    this.ensureRoom(chatId);
    this.roomEvents.push({
      roomId: chatId,
      content: event.content,
      messageType: event.messageType,
      metadata: event.metadata,
    });
    return { ok: true };
  }

  public async createChat(taskId?: string): Promise<{ id: string }> {
    this.createChatCalls.push(taskId);
    this.roomCounter += 1;
    const roomId = `room-${this.roomCounter}`;
    this.ensureRoom(roomId);
    return { id: roomId };
  }

  public async listChatParticipants(chatId: string): Promise<ChatParticipant[]> {
    this.ensureRoom(chatId);
    return [...(this.roomParticipants.get(chatId) ?? [])];
  }

  public async addChatParticipant(
    chatId: string,
    participant: { participantId: string; role: string },
  ): Promise<Record<string, unknown>> {
    this.ensureRoom(chatId);
    const peer = this.peers.find((candidate) => candidate.id === participant.participantId);
    if (!peer) {
      throw new Error(`Unknown peer id '${participant.participantId}'`);
    }

    const existing = this.roomParticipants.get(chatId) ?? [];
    if (existing.some((entry) => entry.id === peer.id)) {
      return { ok: true, status: "already_present" };
    }

    existing.push({
      id: peer.id,
      name: peer.name,
      handle: peer.handle,
      type: "Agent",
    });
    this.roomParticipants.set(chatId, existing);
    return { ok: true, role: participant.role };
  }

  public async removeChatParticipant(chatId: string, participantId: string): Promise<Record<string, unknown>> {
    this.ensureRoom(chatId);
    const existing = this.roomParticipants.get(chatId) ?? [];
    this.roomParticipants.set(
      chatId,
      existing.filter((entry) => entry.id !== participantId),
    );

    return { ok: true };
  }

  public async markMessageProcessing(): Promise<Record<string, unknown>> {
    return { ok: true };
  }

  public async markMessageProcessed(): Promise<Record<string, unknown>> {
    return { ok: true };
  }

  public async markMessageFailed(): Promise<Record<string, unknown>> {
    return { ok: true };
  }

  public async listPeers(request: {
    page: number;
    pageSize: number;
    notInChat: string;
  }): Promise<PaginatedResponse<Record<string, unknown>>> {
    const page = Math.max(1, request.page);
    const pageSize = Math.max(1, request.pageSize);
    const participants = new Set((this.roomParticipants.get(request.notInChat) ?? []).map((entry) => entry.id));
    const available = this.peers.filter((peer) => !participants.has(peer.id));

    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const slice = available.slice(start, end);

    return {
      data: slice.map((peer) => ({
        id: peer.id,
        name: peer.name,
        handle: peer.handle,
      })),
      metadata: {
        page,
        pageSize: pageSize,
        totalCount: available.length,
        totalPages: Math.max(1, Math.ceil(available.length / pageSize)),
      },
    };
  }

  public async getChatContext(request: {
    chatId: string;
    page?: number;
    pageSize?: number;
  }): Promise<PaginatedResponse<PlatformChatMessage>> {
    this.ensureRoom(request.chatId);
    const page = Math.max(1, request.page ?? 1);
    const pageSize = Math.max(1, request.pageSize ?? 100);
    const messages = this.roomMessagesByRoom.get(request.chatId) ?? [];
    const start = (page - 1) * pageSize;
    const end = start + pageSize;

    return {
      data: messages.slice(start, end),
      metadata: {
        page,
        pageSize,
        totalCount: messages.length,
        totalPages: Math.max(1, Math.ceil(messages.length / pageSize)),
      },
    };
  }

  private ensureRoom(roomId: string): void {
    if (this.rooms.has(roomId)) {
      return;
    }

    this.rooms.add(roomId);
    this.roomParticipants.set(roomId, []);
    this.roomMessagesByRoom.set(roomId, []);
  }
}

export { LinearBandExampleRestApi as LinearThenvoiExampleRestApi };
