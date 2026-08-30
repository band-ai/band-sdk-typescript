import type {
  ToolCall,
  ToolCallingModel,
  ToolCallingModelRequest,
  ToolCallingResponse,
  ToolResult,
} from "../tool-calling";
import { RuntimeStateError, UnsupportedFeatureError } from "../../core/errors";
import { toDisplayText, toWireString } from "../shared/coercion";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
import { loadOptionalPeer } from "../shared/optionalPeer";
import {
  normalizeConversationRole,
} from "../tool-calling/valueUtils";

/**
 * Merge consecutive Gemini contents with the same role by combining their parts arrays.
 * Required because the Gemini API rejects consecutive same-role messages.
 */
function mergeConsecutiveGeminiContents(
  contents: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (contents.length <= 1) {
    return contents;
  }

  const merged: Array<Record<string, unknown>> = [];
  for (const msg of contents) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role && Array.isArray(prev.parts) && Array.isArray(msg.parts)) {
      prev.parts = [...(prev.parts as unknown[]), ...(msg.parts as unknown[])];
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}

interface GeminiGenerateResponseLike {
  text?: string;
  functionCalls?: Array<{
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  }>;
}

interface GeminiClientLike {
  models: {
    generateContent(params: Record<string, unknown>): Promise<GeminiGenerateResponseLike>;
  };
}

export type GeminiClientFactory = (input: { apiKey?: string }) => Promise<GeminiClientLike>;

export interface GeminiToolCallingModelOptions {
  model: string;
  apiKey?: string;
  clientFactory?: GeminiClientFactory;
  partFactory?: {
    createPartFromFunctionCall: (name: string, args: Record<string, unknown>) => unknown;
    createPartFromFunctionResponse: (
      id: string,
      name: string,
      response: Record<string, unknown>,
    ) => unknown;
  };
}

export class GeminiToolCallingModel implements ToolCallingModel {
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly clientFactory?: GeminiClientFactory;
  private readonly clientLoader: LazyAsyncValue<GeminiClientLike>;
  private readonly partFactoryLoader: LazyAsyncValue<void>;
  private createPartFromFunctionCall: ((name: string, args: Record<string, unknown>) => unknown) | null = null;
  private createPartFromFunctionResponse:
    | ((id: string, name: string, response: Record<string, unknown>) => unknown)
    | null = null;

  public constructor(options: GeminiToolCallingModelOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.clientFactory = options.clientFactory;
    this.createPartFromFunctionCall = options.partFactory?.createPartFromFunctionCall ?? null;
    this.createPartFromFunctionResponse =
      options.partFactory?.createPartFromFunctionResponse ?? null;
    this.clientLoader = new LazyAsyncValue({
      load: async () => {
        const factory = this.clientFactory ?? (await loadGeminiClientFactory());
        return factory({ apiKey: this.apiKey });
      },
    });
    this.partFactoryLoader = new LazyAsyncValue({
      load: async () => {
        const module = (await import("@google/genai")) as {
          createPartFromFunctionCall?: (
            name: string,
            args: Record<string, unknown>,
          ) => unknown;
          createPartFromFunctionResponse?: (
            id: string,
            name: string,
            response: Record<string, unknown>,
          ) => unknown;
        };

        if (!module.createPartFromFunctionCall || !module.createPartFromFunctionResponse) {
          throw new UnsupportedFeatureError(
            'GeminiAdapter requires createPartFromFunctionCall/createPartFromFunctionResponse from "@google/genai".',
          );
        }

        this.createPartFromFunctionCall = module.createPartFromFunctionCall;
        this.createPartFromFunctionResponse = module.createPartFromFunctionResponse;
      },
    });
  }

  public async complete(request: ToolCallingModelRequest): Promise<ToolCallingResponse> {
    const client = await this.getClient();
    await this.ensurePartFactories();

    const response = await client.models.generateContent({
      model: this.model,
      contents: this.toGeminiContents(request),
      config: {
        systemInstruction: request.systemPrompt,
        tools: this.toGeminiTools(request.tools),
      },
    });

    return {
      text: (response.text ?? "").trim() || undefined,
      toolCalls: this.toToolCalls(response.functionCalls),
    };
  }

  private toGeminiTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const declarations = tools
      .map((tool) => openAIToolToGeminiDeclaration(tool))
      .filter((entry): entry is Record<string, unknown> => entry !== null);

    if (declarations.length === 0) {
      return [];
    }

    return [{ functionDeclarations: declarations }];
  }

  private toGeminiContents(request: ToolCallingModelRequest): Array<Record<string, unknown>> {
    const contents: Array<Record<string, unknown>> = [];

    for (const entry of request.messages) {
      const converted = this.toBaseContent(entry);
      if (!converted) {
        continue;
      }
      contents.push(converted);
    }

    // Merge consecutive same-role entries before appending tool call/result blocks.
    const merged = mergeConsecutiveGeminiContents(contents);

    const rounds = request.toolRounds ?? [];
    if (rounds.length === 0) {
      return merged;
    }

    const partFromCall = this.createPartFromFunctionCall;
    const partFromResponse = this.createPartFromFunctionResponse;
    if (!partFromCall || !partFromResponse) {
      throw new RuntimeStateError("Part factories not initialized. Call ensurePartFactories() first.");
    }

    for (const round of rounds) {
      merged.push({
        role: "model",
        parts: round.toolCalls.map((call) => partFromCall(call.name, call.input)),
      });

      merged.push({
        role: "user",
        parts: round.toolResults.map((result) =>
          partFromResponse(
            result.toolCallId,
            result.name,
            asFunctionResponsePayload(result),
          ),
        ),
      });
    }

    return merged;
  }

  private toBaseContent(entry: Record<string, unknown>): Record<string, unknown> | null {
    const role = normalizeConversationRole(entry.role);
    if (!role) {
      return null;
    }

    const content = toDisplayText(entry.content);
    if (role === "assistant") {
      return { role: "model", parts: [{ text: content }] };
    }

    if (role === "system") {
      return { role: "user", parts: [{ text: `[System]: ${content}` }] };
    }

    return { role: "user", parts: [{ text: content }] };
  }

  private toToolCalls(
    functionCalls: GeminiGenerateResponseLike["functionCalls"],
  ): ToolCall[] | undefined {
    if (!Array.isArray(functionCalls) || functionCalls.length === 0) {
      return undefined;
    }

    const calls: ToolCall[] = [];
    for (let i = 0; i < functionCalls.length; i += 1) {
      const call = functionCalls[i];
      if (!call || typeof call !== "object") {
        continue;
      }

      const name = typeof call.name === "string" ? call.name : null;
      if (!name) {
        continue;
      }

      const id = typeof call.id === "string" && call.id
        ? call.id
        : `gemini_call_${i + 1}`;

      calls.push({
        id,
        name,
        input: call.args && typeof call.args === "object" && !Array.isArray(call.args)
          ? call.args
          : {},
      });
    }

    return calls.length > 0 ? calls : undefined;
  }

  private async getClient(): Promise<GeminiClientLike> {
    return this.clientLoader.get();
  }

  private async ensurePartFactories(): Promise<void> {
    if (this.createPartFromFunctionCall && this.createPartFromFunctionResponse) {
      return;
    }

    return this.partFactoryLoader.get();
  }
}

function asFunctionResponsePayload(result: ToolResult): Record<string, unknown> {
  if (result.output && typeof result.output === "object" && !Array.isArray(result.output)) {
    return { output: result.output as Record<string, unknown> };
  }

  return { output: toWireString(result.output) };
}

function openAIToolToGeminiDeclaration(
  tool: Record<string, unknown>,
): Record<string, unknown> | null {
  const fn = tool.function;
  if (!fn || typeof fn !== "object") {
    return null;
  }

  const fnRecord = fn as Record<string, unknown>;
  const name = typeof fnRecord.name === "string" ? fnRecord.name : null;
  if (!name) {
    return null;
  }

  return {
    name,
    description: typeof fnRecord.description === "string" ? fnRecord.description : undefined,
    parametersJsonSchema: fnRecord.parameters ?? {
      type: "object",
      properties: {},
      required: [],
    },
  };
}

async function loadGeminiClientFactory(): Promise<GeminiClientFactory> {
  const GoogleGenAI = await loadOptionalPeer({
    feature: "GeminiAdapter",
    packageName: "@google/genai",
    importModule: () => import("@google/genai"),
    expectedExports: "`GoogleGenAI`",
    select: (module) =>
      module.GoogleGenAI as
        | (new (options?: { apiKey?: string }) => GeminiClientLike)
        | undefined,
  });

  return async ({ apiKey }) => new GoogleGenAI({ apiKey });
}
