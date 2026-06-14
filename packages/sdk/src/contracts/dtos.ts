import type { MemorySystem, MemoryType } from "./memory";

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

export type MemoryScope = "subject" | "organization" | "all";
export type MemoryVisibility = Exclude<MemoryScope, "all">;
export type { MemorySystem, MemoryType };
export type MemorySegment = "user" | "agent" | "tool" | "guideline";
export type MemoryStatus = "active" | "superseded" | "archived" | "all";

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
