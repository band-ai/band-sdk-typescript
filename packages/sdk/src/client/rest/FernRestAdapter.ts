import { UnsupportedFeatureError } from "../../core/errors";
import { asNullableString, asOptionalRecord, asString } from "../../adapters/shared/coercion";
import type {
  AddContactArgs,
  ContactRecord,
  ContactRequestsResult,
  ListContactRequestsArgs,
  ListContactsArgs,
  ListMemoriesArgs,
  MemoryRecord,
  MentionReference,
  MetadataMap,
  PeerRecord,
  RemoveContactArgs,
  RespondContactRequestArgs,
  StoreMemoryArgs,
  ToolOperationResult,
} from "../../contracts/dtos";
import { DEFAULT_REQUEST_OPTIONS, type RestRequestOptions } from "./requestOptions";
import { normalizePaginationMetadata } from "./pagination";
import { normalizeContactRequestsResult } from "./responseNormalization";
import type {
  FernUserProfile,
  FernThenvoiClientLike,
  RestApi,
  AgentIdentity,
  ChatParticipant,
  PaginatedResponse,
  PlatformChatMessage,
} from "./types";

function mergeOptions(options?: RestRequestOptions): RestRequestOptions {
  return {
    ...DEFAULT_REQUEST_OPTIONS,
    ...options,
  };
}

const AGENT_ME_RETRY_LIMIT = 4;
const AGENT_ME_RETRY_BASE_DELAY_MS = 2_000;
const MESSAGE_SEND_RETRY_LIMIT = 3;
const MESSAGE_SEND_RETRY_BASE_DELAY_MS = 500;

function asMetadataMap(value: unknown): MetadataMap | undefined {
  return asOptionalRecord(value) as MetadataMap | undefined;
}

function extractHttpStatus(error: unknown): number | undefined {
  const record = asOptionalRecord(error);
  if (!record) {
    return undefined;
  }

  const response = asOptionalRecord(record.response);
  const status = record.statusCode ?? record.status ?? response?.statusCode ?? response?.status;
  return typeof status === "number" ? status : undefined;
}

export function isFernRateLimitError(error: unknown): boolean {
  return extractHttpStatus(error) === 429;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function computeRetryDelayMs(baseDelayMs: number, attempt: number): number {
  const backoff = baseDelayMs * (2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(backoff / 4)));
  return backoff + jitter;
}

async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  options: {
    retryLimit: number;
    baseDelayMs: number;
  },
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.retryLimit; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isFernRateLimitError(error) || attempt === options.retryLimit) {
        throw error;
      }

      await sleep(computeRetryDelayMs(options.baseDelayMs, attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Rate-limit retry exhausted without a terminal error.");
}

function requireNonEmptyStringField(
  value: unknown,
  field: string,
  source: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${source} response: expected non-empty string AgentIdentity.${field}`);
  }

  return value;
}

function normalizeOptionalStringField(
  value: unknown,
  field: string,
  source: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`Invalid ${source} response: expected string or null AgentIdentity.${field}`);
  }

  return value;
}

function normalizeAgentIdentityRecord(
  record: MetadataMap,
  source: string,
): AgentIdentity {
  return {
    id: requireNonEmptyStringField(record.id, "id", source),
    name: requireNonEmptyStringField(record.name, "name", source),
    description: normalizeOptionalStringField(record.description, "description", source),
    handle: normalizeOptionalStringField(record.handle, "handle", source),
    ownerUuid: normalizeOptionalStringField(record.owner_uuid, "ownerUuid", source),
  };
}

function normalizeAgentIdentityEnvelope(
  value: unknown,
  source: string,
): AgentIdentity {
  const payload = asMetadataMap(extractEnvelopeData(value));
  if (!payload) {
    throw new Error(`Invalid ${source} response: expected object payload for AgentIdentity`);
  }

  return normalizeAgentIdentityRecord(payload, source);
}

function normalizeLegacyProfileIdentity(
  profile: FernUserProfile,
  source: string,
): AgentIdentity {
  const id = requireNonEmptyStringField(profile.id, "id", source);
  const derivedName = profile.name
    ?? ([profile.first_name, profile.last_name].filter(Boolean).join(" ").trim() || undefined)
    ?? profile.username
    ?? profile.id;
  const name = requireNonEmptyStringField(derivedName, "name", source);

  return {
    id,
    name,
    description: profile.description ?? null,
    handle: null,
    ownerUuid: null,
  };
}

function normalizeLegacyProfileEnvelope(value: unknown): FernUserProfile {
  const payload = asMetadataMap(extractEnvelopeData(value));
  if (!payload) {
    throw new Error("Invalid profile.getMyProfile response: expected object payload");
  }

  return payload as unknown as FernUserProfile;
}

function asRecordArray(value: unknown): MetadataMap[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is MetadataMap => asOptionalRecord(entry) !== undefined);
}

function extractEnvelopeData(value: unknown): unknown {
  const record = asMetadataMap(value);
  if (!record || record.data === undefined) {
    return value;
  }

  return record.data;
}

function extractEnvelopeMetadata(value: unknown): MetadataMap | undefined {
  const record = asMetadataMap(value);
  if (!record) {
    return undefined;
  }

  return asMetadataMap(record.metadata) ?? asMetadataMap(record.meta);
}

export function normalizeFernPaginatedResponse<T>(
  response: unknown,
  normalizeItem: (value: MetadataMap) => T | null,
): PaginatedResponse<T> {
  const topLevelData = extractEnvelopeData(response);
  const nestedData = extractEnvelopeData(topLevelData);
  const rawItems = asRecordArray(topLevelData) ?? asRecordArray(nestedData) ?? [];

  return {
    data: rawItems
      .map((item) => normalizeItem(item))
      .filter((item): item is T => item !== null),
    metadata: normalizePaginationMetadata(
      extractEnvelopeMetadata(response) ?? extractEnvelopeMetadata(topLevelData),
    ),
  };
}

export function normalizeFernContactRequestsResponse(response: unknown): ContactRequestsResult {
  const payload = asMetadataMap(extractEnvelopeData(response));
  return normalizeContactRequestsResult({
    received: asRecordArray(payload?.received) ?? [],
    sent: asRecordArray(payload?.sent) ?? [],
    metadata: extractEnvelopeMetadata(response) ?? extractEnvelopeMetadata(payload),
  });
}

function normalizeToolOperationResult(response: unknown): ToolOperationResult {
  return asMetadataMap(extractEnvelopeData(response)) ?? {};
}

function normalizeMemoryRecord(response: unknown): MemoryRecord {
  const payload = asMetadataMap(extractEnvelopeData(response));
  return payload ? normalizeMemoryRecordItem(payload) ?? {} : {};
}

function extractChatId(response: unknown): string | undefined {
  const payload = asMetadataMap(extractEnvelopeData(response));
  return typeof payload?.id === "string" ? payload.id : undefined;
}

function isChatParticipant(value: unknown): value is ChatParticipant {
  const record = asMetadataMap(value);
  if (!record) {
    return false;
  }

  return typeof record.id === "string"
    && typeof record.name === "string"
    && typeof record.type === "string"
    && (record.handle === undefined || record.handle === null || typeof record.handle === "string");
}

function normalizeChatParticipantsResponse(response: unknown): ChatParticipant[] {
  const payload = extractEnvelopeData(response);
  return Array.isArray(payload) ? payload.filter(isChatParticipant) : [];
}

function normalizeMetadataRecord(value: MetadataMap): MetadataMap {
  return value;
}

function hasInvalidString(value: unknown): boolean {
  return value !== undefined && typeof value !== "string";
}

function hasInvalidNullableString(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== "string";
}

function hasInvalidNullableBoolean(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== "boolean";
}

function normalizePeerRecord(value: MetadataMap): PeerRecord | null {
  if (
    hasInvalidString(value.id)
    || hasInvalidString(value.name)
    || hasInvalidString(value.type)
    || hasInvalidNullableString(value.handle)
    || hasInvalidNullableString(value.description)
  ) {
    return null;
  }

  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(value.handle !== undefined ? { handle: value.handle as string | null } : {}),
    ...(value.description !== undefined ? { description: value.description as string | null } : {}),
  };
}

function normalizeContactRecord(value: MetadataMap): ContactRecord | null {
  if (
    hasInvalidString(value.id)
    || hasInvalidString(value.handle)
    || hasInvalidNullableString(value.name)
    || hasInvalidString(value.type)
    || hasInvalidNullableString(value.description)
    || hasInvalidNullableBoolean(value.is_external)
    || hasInvalidString(value.inserted_at)
  ) {
    return null;
  }

  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.handle === "string" ? { handle: value.handle } : {}),
    ...(value.name !== undefined ? { name: value.name as string | null } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(value.description !== undefined ? { description: value.description as string | null } : {}),
    ...(value.is_external !== undefined ? { is_external: value.is_external as boolean | null } : {}),
    ...(typeof value.inserted_at === "string" ? { inserted_at: value.inserted_at } : {}),
  };
}

function normalizeMemoryRecordItem(value: MetadataMap): MemoryRecord | null {
  if (
    hasInvalidString(value.id)
    || hasInvalidString(value.content)
    || hasInvalidString(value.system)
    || hasInvalidString(value.type)
    || hasInvalidString(value.segment)
    || hasInvalidNullableString(value.thought)
    || hasInvalidNullableString(value.subject_id)
    || hasInvalidNullableString(value.source_agent_id)
    || hasInvalidNullableString(value.organization_id)
    || hasInvalidString(value.scope)
    || hasInvalidString(value.status)
    || (value.metadata !== undefined && value.metadata !== null && asMetadataMap(value.metadata) === undefined)
    || hasInvalidNullableString(value.inserted_at)
  ) {
    return null;
  }

  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.content === "string" ? { content: value.content } : {}),
    ...(typeof value.system === "string" ? { system: value.system } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(typeof value.segment === "string" ? { segment: value.segment } : {}),
    ...(value.thought !== undefined ? { thought: value.thought as string | null } : {}),
    ...(value.subject_id !== undefined ? { subject_id: value.subject_id as string | null } : {}),
    ...(value.source_agent_id !== undefined ? { source_agent_id: value.source_agent_id as string | null } : {}),
    ...(value.organization_id !== undefined ? { organization_id: value.organization_id as string | null } : {}),
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(value.metadata !== undefined
      ? { metadata: value.metadata === null ? null : asMetadataMap(value.metadata) ?? null }
      : {}),
    ...(value.inserted_at !== undefined ? { inserted_at: value.inserted_at as string | null } : {}),
  };
}

function normalizePlatformMessageRecord(value: MetadataMap): PlatformChatMessage | null {
  return normalizePlatformChatMessage(value);
}

function normalizePlatformChatMessage(value: unknown): PlatformChatMessage | null {
  const payload = asMetadataMap(value);
  if (!payload) {
    return null;
  }

  const id = asString(payload.id);
  const content = asString(payload.content);
  const senderId = asString(payload.sender_id) ?? asString(payload.senderId);
  const senderType = asString(payload.sender_type) ?? asString(payload.senderType);
  const messageType = asString(payload.message_type) ?? asString(payload.messageType);
  const insertedAt = asString(payload.inserted_at) ?? asString(payload.insertedAt);
  if (!id || !content || !senderId || !senderType || !messageType || !insertedAt) {
    return null;
  }

  const senderName = asNullableString(payload.sender_name ?? payload.senderName);
  const updatedAt = asNullableString(payload.updated_at ?? payload.updatedAt);
  const metadata = payload.metadata === null ? null : asMetadataMap(payload.metadata);

  return {
    id,
    content,
    sender_id: senderId,
    sender_type: senderType,
    sender_name: senderName,
    message_type: messageType,
    metadata: payload.metadata === null ? null : metadata,
    inserted_at: insertedAt,
    updated_at: updatedAt,
  };
}

export class FernRestAdapter implements RestApi {
  private readonly client: FernThenvoiClientLike;

  public constructor(client: FernThenvoiClientLike) {
    this.client = client;
  }

  public async getAgentMe(options?: RestRequestOptions): Promise<AgentIdentity> {
    return withRateLimitRetry(
      async () => {
        if (this.client.agentApiIdentity?.getAgentMe) {
          const response = await this.client.agentApiIdentity.getAgentMe(mergeOptions(options));
          return normalizeAgentIdentityEnvelope(response, "agentApiIdentity.getAgentMe");
        }

        const profileClient = this.client.myProfile ?? this.client.humanApiProfile;
        if (!profileClient?.getMyProfile) {
          throw new UnsupportedFeatureError(
            "Fern client missing agentApiIdentity.getAgentMe or humanApiProfile.getMyProfile",
          );
        }

        const profile = await profileClient.getMyProfile(mergeOptions(options));
        return normalizeLegacyProfileIdentity(
          normalizeLegacyProfileEnvelope(profile),
          "profile.getMyProfile",
        );
      },
      {
        retryLimit: AGENT_ME_RETRY_LIMIT,
        baseDelayMs: AGENT_ME_RETRY_BASE_DELAY_MS,
      },
    );
  }

  public async createChatMessage(
    chatId: string,
    message: {
      content: string;
      messageType?: string;
      metadata?: MetadataMap;
      mentions?: MentionReference[];
    },
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    const api = this.client.chatMessages?.createChatMessage?.bind(this.client.chatMessages)
      ?? this.client.agentApiMessages?.createAgentChatMessage?.bind(this.client.agentApiMessages)
      ?? this.client.myChatMessages?.createMyChatMessage?.bind(this.client.myChatMessages);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing chat message creation endpoint");
    }

    const response = await withRateLimitRetry(
      async () => await api(
        chatId,
        {
          message: {
            content: message.content,
            message_type: message.messageType,
            metadata: message.metadata,
            mentions: message.mentions,
          },
        },
        mergeOptions(options),
      ),
      {
        retryLimit: MESSAGE_SEND_RETRY_LIMIT,
        baseDelayMs: MESSAGE_SEND_RETRY_BASE_DELAY_MS,
      },
    );
    return normalizeToolOperationResult(response);
  }

  public async createChatEvent(
    chatId: string,
    event: {
      content: string;
      messageType: string;
      metadata?: MetadataMap;
    },
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    const createAgentChatEvent = this.client.agentApiEvents?.createAgentChatEvent
      ?.bind(this.client.agentApiEvents);
    if (createAgentChatEvent) {
      const response = await withRateLimitRetry(
        async () => await createAgentChatEvent(
          chatId,
          {
            event: {
              content: event.content,
              message_type: event.messageType,
              metadata: event.metadata,
            },
          },
          mergeOptions(options),
        ),
        {
          retryLimit: MESSAGE_SEND_RETRY_LIMIT,
          baseDelayMs: MESSAGE_SEND_RETRY_BASE_DELAY_MS,
        },
      );
      return normalizeToolOperationResult(response);
    }

    return this.createChatMessage(chatId, event, options);
  }

  public async createChat(taskId?: string, options?: RestRequestOptions): Promise<{ id: string }> {
    const api = this.client.chatRooms?.createChat?.bind(this.client.chatRooms) ?? this.client.agentApiChats?.createAgentChat?.bind(this.client.agentApiChats);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing chat creation endpoint");
    }

    const response = await api(
      {
        chat: {
          task_id: taskId,
        },
      },
      mergeOptions(options),
    );

    const roomId = extractChatId(response);
    if (!roomId) {
      throw new UnsupportedFeatureError("Chat create response did not include id");
    }

    return { id: roomId };
  }

  public async listChatParticipants(
    chatId: string,
    options?: RestRequestOptions,
  ): Promise<ChatParticipant[]> {
    const requestOptions = mergeOptions(options);
    const listChatParticipantsApi = this.client.chatParticipants?.listChatParticipants?.bind(this.client.chatParticipants);
    if (listChatParticipantsApi) {
      return normalizeChatParticipantsResponse(
        await listChatParticipantsApi(chatId, {}, requestOptions),
      );
    }

    const listAgentChatParticipantsApi = this.client.agentApiParticipants?.listAgentChatParticipants?.bind(this.client.agentApiParticipants);
    if (!listAgentChatParticipantsApi) {
      throw new UnsupportedFeatureError("Fern client missing chat participant list endpoint");
    }

    return normalizeChatParticipantsResponse(
      await listAgentChatParticipantsApi(chatId, requestOptions),
    );
  }

  public async addChatParticipant(
    chatId: string,
    participant: { participantId: string; role: string },
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    const api = this.client.chatParticipants?.addChatParticipant?.bind(this.client.chatParticipants)
      ?? this.client.agentApiParticipants?.addAgentChatParticipant?.bind(this.client.agentApiParticipants);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing chat participant add endpoint");
    }

    const response = await api(
      chatId,
      {
        participant: {
          participant_id: participant.participantId,
          role: participant.role,
        },
      },
      mergeOptions(options),
    );
    return normalizeToolOperationResult(response);
  }

  public async removeChatParticipant(
    chatId: string,
    participantId: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    const api = this.client.chatParticipants?.removeChatParticipant?.bind(this.client.chatParticipants)
      ?? this.client.agentApiParticipants?.removeAgentChatParticipant?.bind(this.client.agentApiParticipants);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing chat participant remove endpoint");
    }

    const response = await api(chatId, participantId, mergeOptions(options));
    return normalizeToolOperationResult(response);
  }

  public async markMessageProcessing(
    chatId: string,
    messageId: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    const api = this.client.chatMessages?.markMessageProcessing?.bind(this.client.chatMessages)
      ?? this.client.agentApiMessages?.markAgentMessageProcessing?.bind(this.client.agentApiMessages);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing mark message processing endpoint");
    }

    const response = await api(chatId, messageId, mergeOptions(options));
    return normalizeToolOperationResult(response);
  }

  public async markMessageProcessed(
    chatId: string,
    messageId: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    const api = this.client.chatMessages?.markMessageProcessed?.bind(this.client.chatMessages)
      ?? this.client.agentApiMessages?.markAgentMessageProcessed?.bind(this.client.agentApiMessages);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing mark message processed endpoint");
    }

    const response = await api(chatId, messageId, mergeOptions(options));
    return normalizeToolOperationResult(response);
  }

  public async markMessageFailed(
    chatId: string,
    messageId: string,
    error: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    const api = this.client.chatMessages?.markMessageFailed?.bind(this.client.chatMessages)
      ?? this.client.agentApiMessages?.markAgentMessageFailed?.bind(this.client.agentApiMessages);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing mark message failed endpoint");
    }

    const response = await api(
      chatId,
      messageId,
      { error },
      mergeOptions(options),
    );
    return normalizeToolOperationResult(response);
  }

  public async getNextMessage(
    request: { chatId: string },
    options?: RestRequestOptions,
  ): Promise<PlatformChatMessage | null> {
    const api = this.client.chatMessages?.getNextMessage?.bind(this.client.chatMessages)
      ?? this.client.agentApiMessages?.getAgentNextMessage?.bind(this.client.agentApiMessages);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing next-message endpoint");
    }

    const response = await withRateLimitRetry(
      async () => api(request.chatId, mergeOptions(options)),
      {
        retryLimit: MESSAGE_SEND_RETRY_LIMIT,
        baseDelayMs: MESSAGE_SEND_RETRY_BASE_DELAY_MS,
      },
    );
    return normalizePlatformChatMessage(extractEnvelopeData(response));
  }

  public async listPeers(
    request: { page: number; pageSize: number; notInChat: string },
    options?: RestRequestOptions,
  ): Promise<{ data: PeerRecord[]; metadata?: MetadataMap }> {
    const api = this.client.agentPeers?.listAgentPeers?.bind(this.client.agentPeers) ?? this.client.agentApiPeers?.listAgentPeers?.bind(this.client.agentApiPeers);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing peer list endpoint");
    }

    const response = await api(
      {
        page: request.page,
        page_size: request.pageSize,
        ...(request.notInChat ? { not_in_chat: request.notInChat } : {}),
      },
      mergeOptions(options),
    );
    return normalizeFernPaginatedResponse(response, normalizePeerRecord);
  }

  public async listChats(
    request: { page: number; pageSize: number },
    options?: RestRequestOptions,
  ): Promise<PaginatedResponse<MetadataMap>> {
    const api = this.client.chatRooms?.listChats?.bind(this.client.chatRooms) ?? this.client.agentApiChats?.listAgentChats?.bind(this.client.agentApiChats);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing chat list endpoint");
    }

    const response = await api(
      {
        page: request.page,
        page_size: request.pageSize,
      },
      mergeOptions(options),
    );

    return normalizeFernPaginatedResponse(response, normalizeMetadataRecord);
  }

  public async listContacts(
    request: ListContactsArgs,
    options?: RestRequestOptions,
  ): Promise<PaginatedResponse<ContactRecord>> {
    const api = this.client.agentContacts?.listAgentContacts?.bind(this.client.agentContacts) ?? this.client.agentApiContacts?.listAgentContacts?.bind(this.client.agentApiContacts);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing contact list endpoint");
    }

    const page = request.page ?? 1;
    const pageSize = request.pageSize ?? 50;

    const response = await api(
      {
        page,
        page_size: pageSize,
      },
      mergeOptions(options),
    );

    return normalizeFernPaginatedResponse(response, normalizeContactRecord);
  }

  public async addContact(
    request: AddContactArgs,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    const api = this.client.agentContacts?.addAgentContact?.bind(this.client.agentContacts) ?? this.client.agentApiContacts?.addAgentContact?.bind(this.client.agentApiContacts);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing add contact endpoint");
    }

    return normalizeToolOperationResult(
      await api(
        { handle: request.handle, ...(request.message ? { message: request.message } : {}) },
        mergeOptions(options),
      ),
    );
  }

  public async removeContact(
    request: RemoveContactArgs,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    const api = this.client.agentContacts?.removeAgentContact?.bind(this.client.agentContacts) ?? this.client.agentApiContacts?.removeAgentContact?.bind(this.client.agentApiContacts);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing remove contact endpoint");
    }

    return normalizeToolOperationResult(
      await api(
        request.target === "handle"
          ? { handle: request.handle }
          : { contact_id: request.contactId },
        mergeOptions(options),
      ),
    );
  }

  public async listContactRequests(
    request: ListContactRequestsArgs,
    options?: RestRequestOptions,
  ): Promise<ContactRequestsResult> {
    const api = this.client.agentContacts?.listAgentContactRequests?.bind(this.client.agentContacts)
      ?? this.client.agentApiContacts?.listAgentContactRequests?.bind(this.client.agentApiContacts);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing contact request list endpoint");
    }

    const page = request.page ?? 1;
    const pageSize = request.pageSize ?? 50;
    const sentStatus = request.sentStatus ?? "pending";

    const response = await api(
      {
        page,
        page_size: pageSize,
        sent_status: sentStatus,
      },
      mergeOptions(options),
    );

    return normalizeFernContactRequestsResponse(response);
  }

  public async respondContactRequest(
    request: RespondContactRequestArgs,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    const api = this.client.agentContacts?.respondToAgentContactRequest?.bind(this.client.agentContacts)
      ?? this.client.agentApiContacts?.respondToAgentContactRequest?.bind(this.client.agentApiContacts);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing contact request response endpoint");
    }

    return normalizeToolOperationResult(
      await api(
        request.target === "handle"
          ? { action: request.action, handle: request.handle }
          : { action: request.action, request_id: request.requestId },
        mergeOptions(options),
      ),
    );
  }

  public async listMemories(
    request: ListMemoriesArgs,
    options?: RestRequestOptions,
  ): Promise<PaginatedResponse<MemoryRecord>> {
    const api = this.client.agentMemories?.listAgentMemories?.bind(this.client.agentMemories) ?? this.client.agentApiMemories?.listAgentMemories?.bind(this.client.agentApiMemories);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing memory list endpoint");
    }

    const response = await api(request, mergeOptions(options));
    return normalizeFernPaginatedResponse(response, normalizeMemoryRecordItem);
  }

  public async storeMemory(
    request: StoreMemoryArgs,
    options?: RestRequestOptions,
  ): Promise<MemoryRecord> {
    const api = this.client.agentMemories?.createAgentMemory?.bind(this.client.agentMemories) ?? this.client.agentApiMemories?.createAgentMemory?.bind(this.client.agentApiMemories);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing create memory endpoint");
    }

    return normalizeMemoryRecord(
      await api(
        { memory: request },
        mergeOptions(options),
      ),
    );
  }

  public async getMemory(
    memoryId: string,
    options?: RestRequestOptions,
  ): Promise<MemoryRecord> {
    const api = this.client.agentMemories?.getAgentMemory?.bind(this.client.agentMemories) ?? this.client.agentApiMemories?.getAgentMemory?.bind(this.client.agentApiMemories);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing get memory endpoint");
    }

    return normalizeMemoryRecord(
      await api(memoryId, mergeOptions(options)),
    );
  }

  public async supersedeMemory(
    memoryId: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    const api = this.client.agentMemories?.supersedeAgentMemory?.bind(this.client.agentMemories)
      ?? this.client.agentApiMemories?.supersedeAgentMemory?.bind(this.client.agentApiMemories);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing supersede memory endpoint");
    }

    return normalizeToolOperationResult(
      await api(memoryId, mergeOptions(options)),
    );
  }

  public async archiveMemory(
    memoryId: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    const api = this.client.agentMemories?.archiveAgentMemory?.bind(this.client.agentMemories)
      ?? this.client.agentApiMemories?.archiveAgentMemory?.bind(this.client.agentApiMemories);
    if (!api) {
      throw new UnsupportedFeatureError("Fern client missing archive memory endpoint");
    }

    return normalizeToolOperationResult(
      await api(memoryId, mergeOptions(options)),
    );
  }

  public async listMessages(
    request: { chatId: string; page: number; pageSize: number; status?: string },
    options?: RestRequestOptions,
  ): Promise<PaginatedResponse<PlatformChatMessage>> {
    const requestOptions = mergeOptions(options);
    const listRequest = {
      page: request.page,
      page_size: request.pageSize,
      status: request.status,
    };

    const listMessagesApi = this.client.chatMessages?.listMessages?.bind(this.client.chatMessages);
    if (listMessagesApi) {
      return normalizeFernPaginatedResponse<PlatformChatMessage>(
        await withRateLimitRetry(
          () => listMessagesApi(request.chatId, listRequest, requestOptions),
          { retryLimit: MESSAGE_SEND_RETRY_LIMIT, baseDelayMs: MESSAGE_SEND_RETRY_BASE_DELAY_MS },
        ),
        normalizePlatformMessageRecord,
      );
    }

    const listAgentMessagesApi = this.client.agentApiMessages?.listAgentMessages?.bind(this.client.agentApiMessages);
    if (!listAgentMessagesApi) {
      throw new UnsupportedFeatureError("Fern client missing message list endpoint");
    }

    return normalizeFernPaginatedResponse<PlatformChatMessage>(
      await withRateLimitRetry(
        () => listAgentMessagesApi(request.chatId, listRequest, requestOptions),
        { retryLimit: MESSAGE_SEND_RETRY_LIMIT, baseDelayMs: MESSAGE_SEND_RETRY_BASE_DELAY_MS },
      ),
      normalizePlatformMessageRecord,
    );
  }

  public async getChatContext(
    request: { chatId: string; page?: number; pageSize?: number },
    options?: RestRequestOptions,
  ): Promise<PaginatedResponse<PlatformChatMessage>> {
    const requestOptions = mergeOptions(options);
    const contextRequest = {
      page: request.page,
      page_size: request.pageSize,
    };

    const getChatContextApi = this.client.chatContext?.getChatContext?.bind(this.client.chatContext);
    if (getChatContextApi) {
      return normalizeFernPaginatedResponse<PlatformChatMessage>(
        await getChatContextApi(request.chatId, contextRequest, requestOptions),
        normalizePlatformMessageRecord,
      );
    }

    const getAgentChatContextApi = this.client.agentApiContext?.getAgentChatContext?.bind(this.client.agentApiContext);
    if (!getAgentChatContextApi) {
      throw new UnsupportedFeatureError("Fern client missing chat context endpoint");
    }

    return normalizeFernPaginatedResponse<PlatformChatMessage>(
      await getAgentChatContextApi(request.chatId, contextRequest, requestOptions),
      normalizePlatformMessageRecord,
    );
  }
}
