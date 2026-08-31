type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type RequestId = number | string;

export type CodexApprovalPolicy =
  | "never"
  | "on-request"
  | "on-failure"
  | "untrusted"
  | {
      reject: {
        sandbox_approval: boolean;
        rules: boolean;
        mcp_elicitations: boolean;
      };
    };

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none";

export interface DynamicToolSpec {
  name: string;
  description: string;
  inputSchema: JsonValue;
}

export interface InitializeParams {
  clientInfo: {
    name: string;
    title: string;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
}

export interface ThreadRef {
  id: string;
}

interface TextUserInput {
  type: "text";
  text: string;
}

interface LocalImageUserInput {
  type: "local_image";
  path: string;
}

export type UserInput = TextUserInput | LocalImageUserInput;

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  model?: string | null;
  effort?: "none" | "low" | "medium" | "high" | "xhigh" | null;
  summary?: CodexReasoningSummary | null;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface TurnErrorInfo {
  message: string;
  additionalDetails: string | null;
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface TurnRef {
  id: string;
  status: TurnStatus;
  error: TurnErrorInfo | null;
}

export interface ThreadStartResponse {
  thread: ThreadRef;
  model: string;
}

export interface ThreadResumeResponse {
  thread: ThreadRef;
  model: string;
}

export interface TurnStartResponse {
  turn: TurnRef;
}

export interface ModelListResponse {
  data: Array<{
    id: string;
    displayName: string;
    description: string;
    hidden: boolean;
    isDefault: boolean;
  }>;
}

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: JsonValue;
}

export interface DynamicToolCallOutputContentItem {
  type: "inputText" | "inputImage";
  text?: string;
  imageUrl?: string;
}

export interface DynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
}

export interface AgentMessageItem {
  type: "agentMessage";
  id: string;
  text: string;
}

export interface ReasoningItem {
  type: "reasoning";
  id: string;
  summary: string[];
  content: string[];
}

export interface PlanItem {
  type: "plan";
  id: string;
  text: string;
}

export interface CommandExecutionItem {
  type: "commandExecution";
  id: string;
  command: string;
  cwd: string;
  aggregatedOutput: string | null;
  exitCode: number | null;
  status: string;
}

export interface FileChangeItem {
  type: "fileChange";
  id: string;
  changes: Array<{ path: string; kind: string }>;
  status: string;
}

export interface McpToolCallItem {
  type: "mcpToolCall";
  id: string;
  server: string;
  tool: string;
  arguments: JsonValue;
  result: JsonValue | null;
  error: JsonValue | null;
}

export interface WebSearchItem {
  type: "webSearch";
  id: string;
  query: string;
  action: JsonValue | null;
}

export interface ImageViewItem {
  type: "imageView";
  id: string;
  path: string;
}

export interface ContextCompactionItem {
  type: "contextCompaction";
  id: string;
}

export interface ReviewModeItem {
  type: "enteredReviewMode" | "exitedReviewMode";
  id: string;
  review: string;
  text?: string;
}

export interface CollabAgentToolCallItem {
  type: "collabAgentToolCall";
  id: string;
  tool: string;
  prompt: string | null;
  agents?: JsonValue;
  result?: JsonValue;
}

export type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | PlanItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | ImageViewItem
  | ContextCompactionItem
  | ReviewModeItem
  | CollabAgentToolCallItem
  | { type: string; id?: string; [key: string]: unknown };
