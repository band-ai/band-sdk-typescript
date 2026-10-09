import type { TASK_ASSIGNMENT_STATUSES, TASK_INCLUDE, TASK_LIFECYCLE_STATES, TASK_LIST_STATES } from "./tasks";
import type {
  MemoryScope,
  MemorySegment,
  MemoryStatus,
  MemorySystem,
  MemoryType,
  MemoryVisibility,
} from "./memory";

export interface MetadataMap {
  [key: string]: unknown;
}

export interface ToolOperationResult {
  ok?: boolean;
  status?: string;
  [key: string]: unknown;
}

export interface MentionReference {
  id: string;
  handle?: string;
  name?: string;
  username?: string;
}

export type MentionInput = string[] | MentionReference[];

export interface PaginationMetadataLike {
  page?: number;
  pageSize?: number;
  totalPages?: number;
  totalCount?: number;
  [key: string]: unknown;
}

export interface PaginatedList<TItem = MetadataMap> {
  data: TItem[];
  metadata?: PaginationMetadataLike;
}

export interface ParticipantRecord {
  id: string;
  name: string;
  type: string;
  handle?: string | null;
  role?: string;
}

export interface PeerRecord {
  id?: string;
  name?: string;
  type?: string;
  handle?: string | null;
  description?: string | null;
}

// Wire DTOs intentionally preserve API snake_case field names.
export interface WireContactRecord {
  id?: string;
  handle?: string;
  name?: string | null;
  type?: string;
  description?: string | null;
  is_external?: boolean | null;
  inserted_at?: string;
}
export type ContactRecord = WireContactRecord;

export interface WireContactRequestRecord {
  id?: string;
  status?: string;
  message?: string | null;
  inserted_at?: string | null;
}
export type ContactRequestRecord = WireContactRequestRecord;

export interface WireReceivedContactRequestRecord extends WireContactRequestRecord {
  from_handle?: string | null;
  from_name?: string | null;
}
export type ReceivedContactRequestRecord = WireReceivedContactRequestRecord;

export interface WireSentContactRequestRecord extends WireContactRequestRecord {
  to_handle?: string | null;
  to_name?: string | null;
}
export type SentContactRequestRecord = WireSentContactRequestRecord;

export interface WireContactRequestsResult {
  received: WireReceivedContactRequestRecord[];
  sent: WireSentContactRequestRecord[];
  metadata?: MetadataMap;
}
export type ContactRequestsResult = WireContactRequestsResult;

export type ContactRequestAction = "approve" | "reject" | "cancel";

export interface ListContactsArgs {
  page?: number;
  pageSize?: number;
}

export interface AddContactArgs {
  handle: string;
  message?: string;
}

export type RemoveContactArgs =
  | { target: "handle"; handle: string }
  | { target: "contactId"; contactId: string };

export interface ListContactRequestsArgs {
  page?: number;
  pageSize?: number;
  sentStatus?: string;
}

export type RespondContactRequestArgs =
  | { action: ContactRequestAction; target: "handle"; handle: string }
  | { action: ContactRequestAction; target: "requestId"; requestId: string };

export type {
  MemoryScope,
  MemorySegment,
  MemoryStatus,
  MemorySystem,
  MemoryType,
  MemoryVisibility,
};

// Wire DTOs intentionally preserve API snake_case field names.
export interface WireListMemoriesArgs {
  subject_id?: string;
  scope?: MemoryScope;
  system?: MemorySystem;
  type?: MemoryType;
  segment?: MemorySegment;
  content_query?: string;
  page_size?: number;
  status?: MemoryStatus;
}
export type ListMemoriesArgs = WireListMemoriesArgs;

export interface WireStoreMemoryArgs {
  content: string;
  system: MemorySystem;
  type: MemoryType;
  segment: MemorySegment;
  thought: string;
  scope?: MemoryVisibility;
  subject_id?: string;
  metadata?: MetadataMap;
}
export type StoreMemoryArgs = WireStoreMemoryArgs;

export interface WireMemoryRecord {
  id?: string;
  content?: string;
  system?: string;
  type?: string;
  segment?: string;
  thought?: string | null;
  subject_id?: string | null;
  source_agent_id?: string | null;
  organization_id?: string | null;
  scope?: string;
  status?: string;
  metadata?: MetadataMap | null;
  inserted_at?: string | null;
}
export type MemoryRecord = WireMemoryRecord;

/** Tool schema as returned by getToolSchemas(). Format depends on the requested format ("openai" or "anthropic"). */
export interface ToolSchemaRecord {
  [key: string]: unknown;
}

export type ToolMessageRole = "system" | "user" | "assistant";

export interface ToolModelMessage {
  role: ToolMessageRole;
  content: unknown;
  sender_name?: string | null;
  sender_type?: string;
  message_type?: string;
  metadata?: MetadataMap;
  [key: string]: unknown;
}

export interface ToolModelSchema {
  [key: string]: unknown;
}

export interface GetBoardArgs {
  include?: (typeof TASK_INCLUDE)[number];
}
export interface SetBoardArgs {
  goal_title?: string;
  goal_summary?: string;
}
export interface ListTasksArgs {
  state?: (typeof TASK_LIST_STATES)[number];
  cursor?: string;
  limit?: number;
}
export interface CreateTaskArgs {
  subject: string;
  detail?: string;
  supersedes_id?: string;
}
export interface GetTaskArgs extends GetBoardArgs {
  id: string;
}
export interface UpdateTaskArgs {
  id: string;
  status?: (typeof TASK_ASSIGNMENT_STATUSES)[number];
  active_form?: string;
  comment?: string;
  subject?: string;
  detail?: string;
  state?: (typeof TASK_LIFECYCLE_STATES)[number];
}
export interface WireTaskActor {
  id: string;
  name: string;
  type: "User" | "Agent";
  handle?: string | null;
}
export interface WireTaskAssignment {
  assignee: WireTaskActor;
  status: NonNullable<UpdateTaskArgs["status"]>;
  active_form: string | null;
  linked_native_id: string | null;
  updated_at: string;
}
export interface WireBoardEvent {
  actor: WireTaskActor;
  at: string;
  event: "goal_set" | "goal_edited";
  payload: MetadataMap;
}
export interface WireTaskEvent {
  actor: WireTaskActor;
  at: string;
  event: "created" | "edited" | "status_changed" | "commented" | "dropped" | "cancelled" | "superseded" | "archived" | "unarchived";
  payload: MetadataMap;
}
export interface WireBoard {
  chat_room_id: string;
  goal_title: string | null;
  goal_summary: string | null;
  created_by: WireTaskActor | null;
  updated_by: WireTaskActor | null;
  inserted_at: string | null;
  updated_at: string | null;
  history?: WireBoardEvent[];
  history_truncated?: boolean;
}
export interface WireTask {
  id: string;
  number: number;
  chat_room_id: string;
  subject: string;
  detail: string;
  state: Exclude<NonNullable<ListTasksArgs["state"]>, "all">;
  overall_status: NonNullable<UpdateTaskArgs["status"]>;
  assignments: WireTaskAssignment[];
  created_by: WireTaskActor;
  superseded_by_id: string | null;
  inserted_at: string;
  updated_at: string;
  history?: WireTaskEvent[];
  history_truncated?: boolean;
}
export interface WireTaskPage {
  data: WireTask[];
  metadata: {
    next_cursor: string | null;
    has_more: boolean;
    limit: number;
  };
}
