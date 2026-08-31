import type { BandClient } from "@band-ai/rest-client";
import type { RestRequestOptions } from "./requestOptions";
import type {
  AddContactArgs,
  ContactRecord,
  ContactRequestsResult,
  ListContactRequestsArgs,
  ListContactsArgs,
  RemoveContactArgs,
  RespondContactRequestArgs,
  ListMemoriesArgs,
  MemoryRecord,
  MentionReference,
  MetadataMap,
  PaginatedList,
  PaginationMetadataLike,
  PeerRecord,
  StoreMemoryArgs,
  ToolOperationResult,
} from "../../contracts/dtos";

export interface AgentIdentity {
  id: string;
  name: string;
  description: string | null;
  handle?: string | null;
  ownerUuid?: string | null;
}

export interface ChatParticipant {
  id: string;
  name: string;
  type: string;
  handle?: string | null;
}

export interface ChatMessageMention {
  id: string;
  handle?: string;
  name?: string;
  username?: string;
}

export interface PaginationMetadata extends PaginationMetadataLike {}

export interface PaginatedResponse<T = MetadataMap> extends PaginatedList<T> {}

export interface PlatformChatMessage {
  id: string;
  content: string;
  sender_id: string;
  sender_type: string;
  sender_name?: string | null;
  message_type: string;
  metadata?: MetadataMap | null;
  inserted_at: string;
  updated_at?: string | null;
}

export interface AgentProfileRestApi {
  getAgentMe(options?: RestRequestOptions): Promise<AgentIdentity>;
}

export interface ChatMessagingRestApi {
  createChatMessage(
    chatId: string,
    message: {
      content: string;
      messageType?: string;
      metadata?: MetadataMap;
      mentions?: MentionReference[];
    },
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult>;
  createChatEvent(
    chatId: string,
    event: {
      content: string;
      messageType: string;
      metadata?: MetadataMap;
    },
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult>;
}

export interface ChatRoomRestApi {
  createChat(taskId?: string, options?: RestRequestOptions): Promise<{ id: string }>;
}

export interface ParticipantRestApi {
  listChatParticipants(
    chatId: string,
    options?: RestRequestOptions,
  ): Promise<ChatParticipant[]>;
  addChatParticipant(
    chatId: string,
    participant: { participantId: string; role: string },
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult>;
  removeChatParticipant(
    chatId: string,
    participantId: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult>;
}

export interface MessageLifecycleRestApi {
  markMessageProcessing(
    chatId: string,
    messageId: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult>;
  markMessageProcessed(
    chatId: string,
    messageId: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult>;
  markMessageFailed(
    chatId: string,
    messageId: string,
    error: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult>;
}

export interface PeerLookupRestApi {
  listPeers?(
    _request: { page: number; pageSize: number; notInChat: string },
    _options?: RestRequestOptions,
  ): Promise<PaginatedResponse<PeerRecord>>;
}

export interface ChatListingRestApi {
  listChats?(
    _request: { page: number; pageSize: number },
    _options?: RestRequestOptions,
  ): Promise<PaginatedResponse>;
}

export interface ContactRestApi {
  listContacts?(
    _request: ListContactsArgs,
    _options?: RestRequestOptions,
  ): Promise<PaginatedResponse<ContactRecord>>;
  addContact?(
    _request: AddContactArgs,
    _options?: RestRequestOptions,
  ): Promise<ToolOperationResult>;
  removeContact?(
    _request: RemoveContactArgs,
    _options?: RestRequestOptions,
  ): Promise<ToolOperationResult>;
  listContactRequests?(
    _request: ListContactRequestsArgs,
    _options?: RestRequestOptions,
  ): Promise<ContactRequestsResult>;
  respondContactRequest?(
    _request: RespondContactRequestArgs,
    _options?: RestRequestOptions,
  ): Promise<ToolOperationResult>;
}

export interface MemoryRestApi {
  listMemories?(
    _request: ListMemoriesArgs,
    _options?: RestRequestOptions,
  ): Promise<PaginatedResponse<MemoryRecord>>;
  storeMemory?(
    _request: StoreMemoryArgs,
    _options?: RestRequestOptions,
  ): Promise<MemoryRecord>;
  getMemory?(
    _memoryId: string,
    _options?: RestRequestOptions,
  ): Promise<MemoryRecord>;
  supersedeMemory?(
    _memoryId: string,
    _options?: RestRequestOptions,
  ): Promise<ToolOperationResult>;
  archiveMemory?(
    _memoryId: string,
    _options?: RestRequestOptions,
  ): Promise<ToolOperationResult>;
}

export interface ContextRestApi {
  getChatContext?(
    _request: { chatId: string; page?: number; pageSize?: number },
    _options?: RestRequestOptions,
  ): Promise<PaginatedResponse<PlatformChatMessage>>;
}

export interface MessageQueueRestApi {
  listMessages?(
    _request: { chatId: string; page: number; pageSize: number; status?: string },
    _options?: RestRequestOptions,
  ): Promise<PaginatedResponse<PlatformChatMessage>>;
  getNextMessage?(
    _request: { chatId: string },
    _options?: RestRequestOptions,
  ): Promise<PlatformChatMessage | null>;
}

export type AgentToolsRestApi =
  & ChatMessagingRestApi
  & ChatRoomRestApi
  & ParticipantRestApi
  & PeerLookupRestApi
  & ContactRestApi
  & MemoryRestApi
  & ContextRestApi
  & MessageQueueRestApi;

export type BandLinkRestApi =
  & AgentProfileRestApi
  & MessageLifecycleRestApi
  & AgentToolsRestApi
  & ChatListingRestApi;

export interface RestApi extends BandLinkRestApi {}

export interface FernUserProfile {
  id: string;
  name?: string;
  description?: string | null;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/**
 * The namespaces of the generated REST client that this SDK consumes. Listing them here
 * (rather than describing them by hand) makes an upstream rename a compile error.
 */
type ConsumedNamespace =
  | "agentApiIdentity"
  | "humanApiProfile"
  | "agentApiPeers"
  | "agentApiContacts"
  | "agentApiMemories"
  | "agentApiMessages"
  | "agentApiEvents"
  | "agentApiChats"
  | "agentApiParticipants"
  | "agentApiContext";

/**
 * Keeps the generated method's parameters — the part the SDK has to get right — and widens
 * only its return type, so the adapter's own response normalizers stay in charge of
 * interpreting payloads and test doubles can resolve plain promises.
 */
type FernMethod<Method> = Method extends (...args: infer Args) => unknown
  ? (...args: Args) => Promise<unknown>
  : never;

type FernNamespace<Namespace> = {
  [Method in keyof Namespace]?: FernMethod<Namespace[Method]>;
};

/**
 * Structural view of `@band-ai/rest-client`'s client, derived from the generated type so
 * the compiler — not a hand-written copy — decides what the SDK may call. Namespaces and
 * methods are optional because the adapter probes for each endpoint and reports an
 * unsupported feature when the installed client predates it.
 */
export type FernBandClientLike = {
  [Namespace in ConsumedNamespace]?: FernNamespace<BandClient[Namespace]>;
};
