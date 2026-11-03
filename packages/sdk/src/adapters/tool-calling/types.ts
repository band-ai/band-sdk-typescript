import type { MetadataMap, ToolModelMessage, ToolModelSchema } from "../../contracts/dtos";

export interface ToolCall {
  id: string;
  name: string;
  input: MetadataMap;
  inputParseError?: string;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  output: unknown;
  isError?: boolean;
}

export interface ToolCallingResponse {
  text?: string;
  toolCalls?: ToolCall[];
  /** Opaque state the producing model needs when it replays this round; others pass it through untouched. */
  providerData?: unknown;
}

export interface ToolRound {
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  /** The `providerData` of the response that made these calls. */
  providerData?: unknown;
}

export interface ToolCallingModelRequest {
  systemPrompt?: string;
  messages: ToolModelMessage[];
  tools: ToolModelSchema[];
  toolRounds?: ToolRound[];
}

export interface ToolCallingModelOptions {
  /** Aborts when the turn's time budget runs out. Pass it to the provider call, so the abandoned request is released. */
  signal?: AbortSignal;
}

export interface ToolCallingModel {
  complete(request: ToolCallingModelRequest, options?: ToolCallingModelOptions): Promise<ToolCallingResponse>;
}
