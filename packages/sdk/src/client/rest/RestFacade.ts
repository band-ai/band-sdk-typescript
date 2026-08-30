import { UnsupportedFeatureError } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import type {
  AddContactArgs,
  ContactRecord,
  ContactRequestsResult,
  ListContactRequestsArgs,
  ListContactsArgs,
  ListMemoriesArgs,
  MemoryRecord,
  MetadataMap,
  MentionReference,
  PeerRecord,
  RemoveContactArgs,
  RespondContactRequestArgs,
  StoreMemoryArgs,
  ToolOperationResult,
} from "../../contracts/dtos";
import { fetchPaginated, normalizePaginationMetadata, type PaginationOptions } from "./pagination";
import { normalizeContactRequestsResult } from "./responseNormalization";
import type {
  AgentIdentity,
  ChatParticipant,
  PaginatedResponse,
  PlatformChatMessage,
  RestApi,
} from "./types";
import type { RestRequestOptions } from "./requestOptions";

export { FernRestAdapter } from "./FernRestAdapter";

interface RestFacadeOptions {
  api: RestApi;
  logger?: Logger;
}

type ListAllChatsOptions = PaginationOptions;
type OptionalRestOperation = {
  [K in keyof RestApi]-?: undefined extends RestApi[K] ? K : never
}[keyof RestApi];

const OPTIONAL_UNSUPPORTED_MESSAGES = {
  listChats: "Chat listing is not available in current REST adapter",
  getChatContext: "Context hydration is not available in current REST adapter",
  listMessages: "Message queue listing is not available in current REST adapter",
  getNextMessage: "Message queue next-item lookup is not available in current REST adapter",
  addContact: "Contact creation is not available in current REST adapter",
  removeContact: "Contact removal is not available in current REST adapter",
  respondContactRequest: "Contact request responses are not available in current REST adapter",
  storeMemory: "Memory creation is not available in current REST adapter",
  getMemory: "Memory lookup is not available in current REST adapter",
  supersedeMemory: "Memory supersede is not available in current REST adapter",
  archiveMemory: "Memory archive is not available in current REST adapter",
  listContacts: "Contact listing is not available in current REST adapter",
  listMemories: "Memory listing is not available in current REST adapter",
  listPeers: "Peer listing is not available in current REST adapter",
  listContactRequests: "Contact request listing is not available in current REST adapter",
} as const;

export class RestFacade implements RestApi {
  private readonly api: RestApi;
  private readonly logger: Logger;

  public constructor(options: RestFacadeOptions) {
    this.api = options.api;
    this.logger = options.logger ?? new NoopLogger();
  }

  public async getAgentMe(options?: RestRequestOptions): Promise<AgentIdentity> {
    return this.forward("getAgentMe", () => this.api.getAgentMe(options));
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
    return this.forward("createChatMessage", () => this.api.createChatMessage(chatId, message, options), {
      chatId,
      messageType: message.messageType ?? "text",
      mentionCount: message.mentions?.length ?? 0,
    });
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
    return this.forward("createChatEvent", () => this.api.createChatEvent(chatId, event, options), {
      chatId,
      messageType: event.messageType,
    });
  }

  public async createChat(taskId?: string, options?: RestRequestOptions): Promise<{ id: string }> {
    return this.forward("createChat", () => this.api.createChat(taskId, options), {
      taskId: taskId ?? null,
    });
  }

  public async listChatParticipants(
    chatId: string,
    options?: RestRequestOptions,
  ): Promise<ChatParticipant[]> {
    return this.forward(
      "listChatParticipants",
      () => this.api.listChatParticipants(chatId, options),
      { chatId },
    );
  }

  public async addChatParticipant(
    chatId: string,
    participant: { participantId: string; role: string },
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    return this.forward("addChatParticipant", () => this.api.addChatParticipant(chatId, participant, options), {
      chatId,
      participantId: participant.participantId,
      role: participant.role,
    });
  }

  public async removeChatParticipant(
    chatId: string,
    participantId: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    return this.forward(
      "removeChatParticipant",
      () => this.api.removeChatParticipant(chatId, participantId, options),
      { chatId, participantId },
    );
  }

  public async markMessageProcessing(
    chatId: string,
    messageId: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    return this.forward(
      "markMessageProcessing",
      () => this.api.markMessageProcessing(chatId, messageId, options),
      { chatId, messageId },
    );
  }

  public async markMessageProcessed(
    chatId: string,
    messageId: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    return this.forward(
      "markMessageProcessed",
      () => this.api.markMessageProcessed(chatId, messageId, options),
      { chatId, messageId },
    );
  }

  public async markMessageFailed(
    chatId: string,
    messageId: string,
    error: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    return this.forward(
      "markMessageFailed",
      () => this.api.markMessageFailed(chatId, messageId, error, options),
      { chatId, messageId },
    );
  }

  public async listChats(
    request: { page: number; pageSize: number },
    options?: RestRequestOptions,
  ): Promise<PaginatedResponse<MetadataMap>> {
    return this.callOptional(
      "listChats",
      OPTIONAL_UNSUPPORTED_MESSAGES.listChats,
      (method) => method(request, options),
      request,
    );
  }

  public async getChatContext(
    request: { chatId: string; page?: number; pageSize?: number },
    options?: RestRequestOptions,
  ): Promise<PaginatedResponse<PlatformChatMessage>> {
    return this.callOptional(
      "getChatContext",
      OPTIONAL_UNSUPPORTED_MESSAGES.getChatContext,
      (method) => method(request, options),
      request,
    );
  }

  public async listMessages(
    request: { chatId: string; page: number; pageSize: number; status?: string },
    options?: RestRequestOptions,
  ): Promise<PaginatedResponse<PlatformChatMessage>> {
    return this.callOptional(
      "listMessages",
      OPTIONAL_UNSUPPORTED_MESSAGES.listMessages,
      (method) => method(request, options),
      request,
    );
  }

  public async getNextMessage(
    request: { chatId: string },
    options?: RestRequestOptions,
  ): Promise<PlatformChatMessage | null> {
    return this.callOptional(
      "getNextMessage",
      OPTIONAL_UNSUPPORTED_MESSAGES.getNextMessage,
      (method) => method(request, options),
      request,
    );
  }

  public async addContact(
    request: AddContactArgs,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    return this.callOptional(
      "addContact",
      OPTIONAL_UNSUPPORTED_MESSAGES.addContact,
      (method) => method(request, options),
      { ...request },
    );
  }

  public async removeContact(
    request: RemoveContactArgs,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    return this.callOptional(
      "removeContact",
      OPTIONAL_UNSUPPORTED_MESSAGES.removeContact,
      (method) => method(request, options),
      request,
    );
  }

  public async respondContactRequest(
    request: RespondContactRequestArgs,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    return this.callOptional(
      "respondContactRequest",
      OPTIONAL_UNSUPPORTED_MESSAGES.respondContactRequest,
      (method) => method(request, options),
      request,
    );
  }

  public async storeMemory(
    request: StoreMemoryArgs,
    options?: RestRequestOptions,
  ): Promise<MemoryRecord> {
    return this.callOptional(
      "storeMemory",
      OPTIONAL_UNSUPPORTED_MESSAGES.storeMemory,
      (method) => method(request, options),
      { ...request },
    );
  }

  public async getMemory(memoryId: string, options?: RestRequestOptions): Promise<MemoryRecord> {
    return this.callOptional(
      "getMemory",
      OPTIONAL_UNSUPPORTED_MESSAGES.getMemory,
      (method) => method(memoryId, options),
      { memoryId },
    );
  }

  public async supersedeMemory(
    memoryId: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    return this.callOptional(
      "supersedeMemory",
      OPTIONAL_UNSUPPORTED_MESSAGES.supersedeMemory,
      (method) => method(memoryId, options),
      { memoryId },
    );
  }

  public async archiveMemory(
    memoryId: string,
    options?: RestRequestOptions,
  ): Promise<ToolOperationResult> {
    return this.callOptional(
      "archiveMemory",
      OPTIONAL_UNSUPPORTED_MESSAGES.archiveMemory,
      (method) => method(memoryId, options),
      { memoryId },
    );
  }

  public async listContacts(
    request: ListContactsArgs,
    options?: RestRequestOptions,
  ): Promise<PaginatedResponse<ContactRecord>> {
    return this.callOptional(
      "listContacts",
      OPTIONAL_UNSUPPORTED_MESSAGES.listContacts,
      async (method) => {
        const response = await method(request, options);
        return {
          data: response.data ?? [],
          metadata: normalizePaginationMetadata(response.metadata),
        };
      },
      { ...request },
    );
  }

  public async listMemories(
    request: ListMemoriesArgs,
    options?: RestRequestOptions,
  ): Promise<PaginatedResponse<MemoryRecord>> {
    return this.callOptional(
      "listMemories",
      OPTIONAL_UNSUPPORTED_MESSAGES.listMemories,
      async (method) => {
        const response = await method(request, options);
        return {
          data: response.data ?? [],
          metadata: normalizePaginationMetadata(response.metadata),
        };
      },
      { ...request },
    );
  }

  public async listPeers(
    request: { page: number; pageSize: number; notInChat: string },
    options?: RestRequestOptions,
  ): Promise<PaginatedResponse<PeerRecord>> {
    return this.callOptional(
      "listPeers",
      OPTIONAL_UNSUPPORTED_MESSAGES.listPeers,
      async (method) => {
        const response = await method(request, options);
        return {
          data: response.data ?? [],
          metadata: normalizePaginationMetadata(response.metadata),
        };
      },
      request,
    );
  }

  public async listContactRequests(
    request: ListContactRequestsArgs,
    options?: RestRequestOptions,
  ): Promise<ContactRequestsResult> {
    return this.callOptional(
      "listContactRequests",
      OPTIONAL_UNSUPPORTED_MESSAGES.listContactRequests,
      async (method) => normalizeContactRequestsResult(await method(request, options)),
      { ...request },
    );
  }

  public async listAllChats(
    options?: ListAllChatsOptions,
    requestOptions?: RestRequestOptions,
  ): Promise<MetadataMap[]> {
    return fetchPaginated({
      fetchPage: ({ page, pageSize }) => this.listChats({ page, pageSize }, requestOptions),
      pageSize: options?.pageSize,
      maxPages: options?.maxPages,
      strategy: options?.strategy,
      metadataValidation: options?.metadataValidation,
    });
  }

  private callOptional<Op extends OptionalRestOperation, Result>(
    operation: Op,
    unsupportedMessage: string,
    invoke: (method: NonNullable<RestApi[Op]>) => Promise<Result>,
    metadata?: Record<string, unknown>,
  ): Promise<Result> {
    const method = this.api[operation];
    if (!method) {
      throw new UnsupportedFeatureError(unsupportedMessage);
    }

    const boundMethod = method.bind(this.api) as NonNullable<RestApi[Op]>;

    return this.forward(String(operation), () => invoke(boundMethod), metadata);
  }

  private forward<T>(
    operation: string,
    call: () => Promise<T>,
    metadata?: Record<string, unknown>,
  ): Promise<T> {
    this.logger.debug(`REST ${operation}`, metadata);
    return call();
  }
}
