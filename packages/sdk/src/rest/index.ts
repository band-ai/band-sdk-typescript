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
  RoomHistoryRestApi,
} from "../client/rest/types";
export {
  fetchCursorTail,
  fetchPaginated,
  getRecentMessages,
  listAllPeers,
  fetchContextPage,
  DEFAULT_CONTEXT_PAGE,
  MAX_CURSOR_PAGE,
  readRoomHistoryPage,
  DEFAULT_ROOM_HISTORY_PAGE,
  MAX_ROOM_HISTORY_PAGE,
  normalizePaginationMetadata,
} from "../client/rest/pagination";
export type { CursorPageRequest, CursorTail, CursorTailOptions } from "../client/rest/pagination";
export { DEFAULT_REQUEST_OPTIONS } from "../client/rest/requestOptions";
export type { ReportActivityOptions } from "../client/rest/requestOptions";
export { FernRestAdapter, RestFacade } from "../client/rest/RestFacade";
export { ActivityCapability } from "../client/rest/activityCapability";
export type { FernRestAdapterOptions } from "../client/rest/FernRestAdapter";

export type { GetBoardArgs, SetBoardArgs, ListTasksArgs, CreateTaskArgs, GetTaskArgs, UpdateTaskArgs, WireBoard, WireTask, WireTaskPage } from "../contracts/dtos";
