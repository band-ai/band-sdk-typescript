import type { MetadataMap, ToolModelMessage, ToolModelSchema } from "../../contracts/dtos";

export interface ToolCall {
  id: string;
  name: string;
  input: MetadataMap;
  inputParseError?: string;
  /**
   * Provider-specific opaque metadata that must be echoed back when this tool
   * call is replayed in the next request (e.g. Gemini 3's `thoughtSignature`).
   * Adapters that don't need it can ignore the field.
   */
  providerMetadata?: Record<string, unknown>;
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
  complete(request: ToolCallingModelRequest): Promise<ToolCallingResponse>;
}
