import type {
  ToolCall,
  ToolCallingModel,
  ToolCallingModelOptions,
  ToolCallingModelRequest,
  ToolCallingResponse,
  ToolResult,
} from "../tool-calling";
import { UnsupportedFeatureError } from "../../core/errors";
import { asOptionalRecord, toDisplayText, toWireString } from "../shared/coercion";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
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

interface GeminiFunctionCallPart {
  functionCall: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
}

interface GeminiModelTurn {
  role: "model";
  parts: unknown[];
}

export interface GeminiGenerateResponseLike {
  text?: string;
  candidates?: Array<{ content?: { parts?: unknown[] } }>;
  /** Read only when `candidates` is absent, as from a custom factory; it carries no thought signatures. */
  functionCalls?: Array<GeminiFunctionCallPart["functionCall"]>;
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

  public async complete(request: ToolCallingModelRequest, options?: ToolCallingModelOptions): Promise<ToolCallingResponse> {
    const client = await this.getClient();
    await this.ensurePartFactories();

    const response = await client.models.generateContent({
      model: this.model,
      contents: this.toGeminiContents(request),
      config: {
        systemInstruction: request.systemPrompt,
        tools: this.toGeminiTools(request.tools),
        abortSignal: options?.signal,
      },
    });

    const toolTurn = this.toToolTurn(responseParts(response));
    return {
      text: (response.text ?? "").trim() || undefined,
      toolCalls: toolTurn?.toolCalls,
      providerData: toolTurn?.modelTurn,
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
      throw new Error("Part factories not initialized. Call ensurePartFactories() first.");
    }

    for (const round of rounds) {
      // Gemini 3 rejects a replayed call without its original thoughtSignature, so the turn goes back as received.
      // Rebuilding from the calls only serves rounds this model did not produce.
      merged.push(isGeminiModelTurn(round.providerData) ? round.providerData : {
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

  /** The calls plus their model turn with ids filled in, so a replay returns each thought signature. */
  private toToolTurn(parts: unknown[] | undefined): { toolCalls: ToolCall[]; modelTurn: GeminiModelTurn } | undefined {
    const calls: ToolCall[] = [];
    const modelTurn: GeminiModelTurn = { role: "model", parts: [] };
    for (const part of parts ?? []) {
      if (!isFunctionCallPart(part)) {
        modelTurn.parts.push(part);
        continue;
      }

      const { id: givenId, name, args } = part.functionCall;
      // A nameless call gets no result, so it is left out of the replay too.
      if (typeof name !== "string" || !name) {
        continue;
      }

      const id = typeof givenId === "string" && givenId ? givenId : `gemini_call_${calls.length + 1}`;
      modelTurn.parts.push({ ...part, functionCall: { ...part.functionCall, id } });
      calls.push({ id, name, input: asOptionalRecord(args) ?? {} });
    }

    return calls.length > 0 ? { toolCalls: calls, modelTurn } : undefined;
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

function responseParts(response: GeminiGenerateResponseLike): unknown[] | undefined {
  return response.candidates?.[0]?.content?.parts
    ?? response.functionCalls?.map((functionCall) => ({ functionCall }));
}

function isGeminiModelTurn(value: unknown): value is GeminiModelTurn {
  const turn = asOptionalRecord(value);
  return turn?.role === "model" && Array.isArray(turn.parts);
}

function isFunctionCallPart(value: unknown): value is GeminiFunctionCallPart {
  return asOptionalRecord(asOptionalRecord(value)?.functionCall) !== undefined;
}

function asFunctionResponsePayload(result: ToolResult): Record<string, unknown> {
  if (result.output && typeof result.output === "object" && !Array.isArray(result.output)) {
    return { output: result.output };
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
  const module = (await import("@google/genai").catch((error: unknown) => {
    throw new UnsupportedFeatureError(
      `GeminiAdapter requires optional dependency "@google/genai". Install it with "pnpm add @google/genai". (${error instanceof Error ? error.message : String(error)})`,
    );
  })) as {
    GoogleGenAI?: new (options?: { apiKey?: string }) => GeminiClientLike;
  };

  if (!module.GoogleGenAI) {
    throw new UnsupportedFeatureError(
      'GeminiAdapter requires optional dependency "@google/genai". Install it with "pnpm add @google/genai".',
    );
  }

  return async ({ apiKey }) => new module.GoogleGenAI!({ apiKey });
}
