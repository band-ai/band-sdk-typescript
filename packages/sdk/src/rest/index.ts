export type {
  AgentIdentity,
  ChatMessageMention,
  ChatParticipant,
  ChatRoom,
  CreateChatRequest,
  FernBandClientLike,
  PaginatedResponse,
  PaginationMetadata,
  PlatformChatMessage,
  RestApi,
  ChatTaskRestApi,
} from "../client/rest/types";
export {
  fetchCursorTail,
  fetchPaginated,
  getRecentMessages,
  listAllPeers,
  normalizePaginationMetadata,
} from "../client/rest/pagination";
export type { CursorPageRequest, CursorTail, CursorTailOptions } from "../client/rest/pagination";
export { DEFAULT_REQUEST_OPTIONS } from "../client/rest/requestOptions";
export { FernRestAdapter, RestFacade } from "../client/rest/RestFacade";

export type { GetBoardArgs, SetBoardArgs, ListTasksArgs, CreateTaskArgs, GetTaskArgs, UpdateTaskArgs, WireBoard, WireTask, WireTaskPage } from "../contracts/dtos";
