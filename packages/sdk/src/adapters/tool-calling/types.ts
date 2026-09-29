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
}

export interface ToolRound {
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
}

export interface ToolCallingModelRequest {
  systemPrompt?: string;
  messages: ToolModelMessage[];
  tools: ToolModelSchema[];
  toolRounds?: ToolRound[];
}

export interface ToolCallingModel {
  /**
   * `options.signal` aborts when the turn's time budget runs out. Honour it by
   * passing it to the provider call, so the abandoned request is released.
   */
  complete(request: ToolCallingModelRequest, options?: { signal?: AbortSignal }): Promise<ToolCallingResponse>;
}
