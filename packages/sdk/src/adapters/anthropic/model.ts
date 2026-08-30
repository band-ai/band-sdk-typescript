import type {
  ToolCall,
  ToolCallingModel,
  ToolCallingModelRequest,
  ToolCallingResponse,
} from "../tool-calling";
import { toDisplayText, toWireString } from "../shared/coercion";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
import { loadOptionalPeer } from "../shared/optionalPeer";
import {
  mapConversationMessages,
  mergeConsecutiveSameRole,
  normalizeConversationRole,
} from "../tool-calling/valueUtils";

interface AnthropicMessageResponseLike {
  content?: unknown;
}

interface AnthropicClientLike {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicMessageResponseLike>;
  };
}

export type AnthropicClientFactory = (input: { apiKey?: string }) => Promise<AnthropicClientLike>;

export interface AnthropicToolCallingModelOptions {
  model: string;
  apiKey?: string;
  maxTokens?: number;
  clientFactory?: AnthropicClientFactory;
}

export class AnthropicToolCallingModel implements ToolCallingModel {
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly maxTokens: number;
  private readonly clientFactory?: AnthropicClientFactory;
  private readonly clientLoader: LazyAsyncValue<AnthropicClientLike>;

  public constructor(options: AnthropicToolCallingModelOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.maxTokens = options.maxTokens ?? 4096;
    this.clientFactory = options.clientFactory;
    this.clientLoader = new LazyAsyncValue({
      load: async () => {
        const factory = this.clientFactory ?? (await loadAnthropicClientFactory());
        return factory({ apiKey: this.apiKey });
      },
    });
  }

  public async complete(request: ToolCallingModelRequest): Promise<ToolCallingResponse> {
    const client = await this.getClient();
    const systemPrompt = request.systemPrompt?.trim();

    const response = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: toAnthropicMessages(request),
      tools: request.tools,
    });

    return parseAnthropicResponse(response);
  }

  private async getClient(): Promise<AnthropicClientLike> {
    return this.clientLoader.get();
  }
}

function toAnthropicMessages(
  request: ToolCallingModelRequest,
): Array<Record<string, unknown>> {
  const messages = mergeConsecutiveSameRole(
    mapConversationMessages(request, toAnthropicMessageWithSystemAsUser),
  );

  const rounds = request.toolRounds ?? [];
  if (rounds.length === 0) {
    return messages;
  }

  for (const round of rounds) {
    messages.push({
      role: "assistant",
      content: round.toolCalls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    });

    messages.push({
      role: "user",
      content: round.toolResults.map((result) => ({
        type: "tool_result",
        tool_use_id: result.toolCallId,
        content: toWireString(result.output),
        is_error: result.isError ?? false,
      })),
    });
  }

  return messages;
}

function toAnthropicMessageWithSystemAsUser(
  entry: Record<string, unknown>,
): Record<string, unknown> | null {
  const role = normalizeConversationRole(entry.role);
  if (!role) {
    return null;
  }

  if (role === "system") {
    return {
      role: "user",
      content: `[System]: ${toDisplayText(entry.content)}`,
    };
  }

  return {
    role,
    content: toDisplayText(entry.content),
  };
}

function parseAnthropicResponse(
  response: AnthropicMessageResponseLike,
): ToolCallingResponse {
  const blocks = Array.isArray(response.content) ? response.content : [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const blockRecord = block as Record<string, unknown>;
    const type = blockRecord.type;

    if (type === "text" && typeof blockRecord.text === "string") {
      textParts.push(blockRecord.text);
      continue;
    }

    if (type !== "tool_use") {
      continue;
    }

    const id = typeof blockRecord.id === "string" ? blockRecord.id : null;
    const name = typeof blockRecord.name === "string" ? blockRecord.name : null;
    if (!id || !name) {
      continue;
    }

    const input = blockRecord.input;
    toolCalls.push({
      id,
      name,
      input: input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {},
    });
  }

  const text = textParts.join("\n").trim();
  return {
    text: text || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

async function loadAnthropicClientFactory(): Promise<AnthropicClientFactory> {
  const AnthropicClientCtor = await loadOptionalPeer({
    feature: "AnthropicAdapter",
    packageName: "@anthropic-ai/sdk",
    importModule: () => import("@anthropic-ai/sdk"),
    expectedExports: "a default or `Anthropic` client constructor",
    select: (module) =>
      (module.default ?? module.Anthropic) as
        | (new (options?: { apiKey?: string }) => AnthropicClientLike)
        | undefined,
  });

  return async ({ apiKey }) => new AnthropicClientCtor({ apiKey });
}
