import type { Message } from "@anthropic-ai/sdk/resources/messages";

import type {
  ToolCall,
  ToolCallingModel,
  ToolCallingModelRequest,
  ToolCallingResponse,
} from "../tool-calling";
import { isRecord, toDisplayText, toWireString } from "../shared/coercion";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
import { loadOptionalPeer } from "../shared/optionalPeer";
import {
  mapConversationMessages,
  mergeConsecutiveSameRole,
  normalizeConversationRole,
} from "../tool-calling/valueUtils";

type AnthropicMessageResponseLike = Pick<Message, "content">;

// Hand-declared on purpose: `clientFactory` is a public seam for injecting a double, and
// the upstream `Anthropic` client's overloaded `create` cannot be implemented by one.
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
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  // `clientFactory` is a public seam, so a caller-supplied double can hand back a shape
  // the upstream type says is impossible. Iterating that directly would throw.
  const blocks = Array.isArray(response.content) ? response.content : [];

  for (const block of blocks) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }

    if (block.type !== "tool_use") {
      continue;
    }

    // Upstream types tool-call input as `unknown`, so it still needs narrowing.
    toolCalls.push({
      id: block.id,
      name: block.name,
      input: isRecord(block.input) ? block.input : {},
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
