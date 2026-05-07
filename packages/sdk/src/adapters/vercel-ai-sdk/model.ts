import type {
  ToolCall,
  ToolCallingModel,
  ToolCallingModelRequest,
  ToolCallingResponse,
} from "../tool-calling";
import { UnsupportedFeatureError } from "../../core/errors";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
import { toDisplayText } from "../shared/coercion";
import { normalizeConversationRole } from "../tool-calling/valueUtils";

interface VercelAISDKToolDefinition {
  description?: string;
  inputSchema: unknown;
}

type VercelAISDKGenerateText = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
type VercelAISDKToolFactory = (definition: VercelAISDKToolDefinition) => unknown;
type VercelAISDKJsonSchemaFactory = (schema: Record<string, unknown>) => unknown;

interface VercelAISDKRuntime {
  generateText: VercelAISDKGenerateText;
  tool: VercelAISDKToolFactory;
  jsonSchema: VercelAISDKJsonSchemaFactory;
}

export interface VercelAISDKToolCallingModelOptions {
  model: unknown;
  generateText?: VercelAISDKGenerateText;
  toolFactory?: VercelAISDKToolFactory;
}

export class VercelAISDKToolCallingModel implements ToolCallingModel {
  private readonly model: unknown;
  private readonly generateTextOverride?: VercelAISDKGenerateText;
  private readonly toolFactoryOverride?: VercelAISDKToolFactory;
  private readonly runtimeLoader: LazyAsyncValue<VercelAISDKRuntime>;

  public constructor(options: VercelAISDKToolCallingModelOptions) {
    this.model = options.model;
    this.generateTextOverride = options.generateText;
    this.toolFactoryOverride = options.toolFactory;
    this.runtimeLoader = new LazyAsyncValue({
      load: async () => {
        const runtime = await loadVercelAISDKRuntime();
        return {
          generateText: this.generateTextOverride ?? runtime.generateText,
          tool: this.toolFactoryOverride ?? runtime.tool,
          jsonSchema: runtime.jsonSchema,
        };
      },
    });
  }

  public async complete(request: ToolCallingModelRequest): Promise<ToolCallingResponse> {
    const runtime = await this.runtimeLoader.get();
    const tools = toVercelAISDKTools(request.tools, runtime.tool, runtime.jsonSchema);

    const { messages, extraSystem } = toVercelAISDKMessages(request);
    const baseSystem = request.systemPrompt?.trim() ?? "";
    const fullSystem = [baseSystem, ...extraSystem]
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join("\n\n");

    const response = await runtime.generateText({
      model: this.model,
      ...(fullSystem ? { system: fullSystem } : {}),
      messages,
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
    });

    return parseVercelAISDKResponse(response);
  }
}

function toVercelAISDKMessages(request: ToolCallingModelRequest): {
  messages: Array<Record<string, unknown>>;
  extraSystem: string[];
} {
  const messages: Array<Record<string, unknown>> = [];
  const extraSystem: string[] = [];

  for (const entry of request.messages) {
    const rawRole = typeof entry.role === "string" ? entry.role : "user";
    const content = toDisplayText((entry as Record<string, unknown>).content);

    if (rawRole === "system") {
      if (content) {
        extraSystem.push(content);
      }
      continue;
    }

    const role = normalizeConversationRole(rawRole);
    if (!role) {
      continue;
    }

    messages.push({ role, content });
  }

  for (const round of request.toolRounds ?? []) {
    messages.push({
      role: "assistant",
      content: round.toolCalls.map((call) => ({
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
      })),
    });

    messages.push({
      role: "tool",
      content: round.toolResults.map((result) => ({
        type: "tool-result",
        toolCallId: result.toolCallId,
        toolName: result.name,
        output: toVercelToolResultOutput(result.output, result.isError === true),
      })),
    });
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }

  return { messages, extraSystem };
}

function toVercelToolResultOutput(value: unknown, isError: boolean): Record<string, unknown> {
  if (typeof value === "string") {
    return { type: isError ? "error-text" : "text", value };
  }
  if (value === null || typeof value === "undefined") {
    return { type: isError ? "error-text" : "text", value: "" };
  }
  return { type: isError ? "error-json" : "json", value: value as Record<string, unknown> };
}

function toVercelAISDKTools(
  schemas: Array<Record<string, unknown>>,
  toolFactory: VercelAISDKToolFactory,
  jsonSchemaFactory: VercelAISDKJsonSchemaFactory,
): Record<string, unknown> {
  const tools: Record<string, unknown> = {};

  for (const schema of schemas) {
    const functionRecordRaw = schema.function;
    if (!functionRecordRaw || typeof functionRecordRaw !== "object" || Array.isArray(functionRecordRaw)) {
      continue;
    }
    const functionRecord = functionRecordRaw as Record<string, unknown>;

    const name = typeof functionRecord.name === "string" ? functionRecord.name : null;
    if (!name) {
      continue;
    }

    const description = typeof functionRecord.description === "string"
      ? functionRecord.description
      : undefined;
    const parameters = functionRecord.parameters;

    const rawSchema = parameters && typeof parameters === "object" && !Array.isArray(parameters)
      ? parameters as Record<string, unknown>
      : { type: "object", properties: {}, required: [] };

    tools[name] = toolFactory({
      ...(description ? { description } : {}),
      inputSchema: jsonSchemaFactory(rawSchema),
    });
  }

  return tools;
}

function parseVercelAISDKResponse(response: Record<string, unknown>): ToolCallingResponse {
  const text = typeof response.text === "string" ? response.text.trim() : "";
  const toolCalls = parseVercelAISDKToolCalls(response.toolCalls);

  return {
    ...(text ? { text } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function parseVercelAISDKToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const toolCalls: ToolCall[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const toolCall = value as Record<string, unknown>;
    const id = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : null;
    const name = typeof toolCall.toolName === "string" ? toolCall.toolName : null;
    if (!id || !name) {
      continue;
    }

    const input = toolCall.input;
    const error = toolCall.error;
    const parseError = toolCall.invalid === true
      ? (error instanceof Error ? error.message : (typeof error === "string" ? error : "Vercel AI SDK returned an invalid tool call."))
      : undefined;

    toolCalls.push({
      id,
      name,
      input: input && typeof input === "object" && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {},
      ...(parseError ? { inputParseError: parseError } : {}),
    });
  }

  return toolCalls;
}

async function loadVercelAISDKRuntime(): Promise<VercelAISDKRuntime> {
  const module = (await import("ai").catch((error: unknown) => {
    throw new UnsupportedFeatureError(
      `VercelAISDKAdapter requires optional dependency "ai". Install it with "pnpm add ai". (${error instanceof Error ? error.message : String(error)})`,
    );
  })) as {
    generateText?: VercelAISDKGenerateText;
    tool?: VercelAISDKToolFactory;
    jsonSchema?: VercelAISDKJsonSchemaFactory;
  };

  if (!module.generateText || !module.tool || !module.jsonSchema) {
    throw new UnsupportedFeatureError(
      'VercelAISDKAdapter requires optional dependency "ai" (>=4.0). Install it with "pnpm add ai".',
    );
  }

  return {
    generateText: module.generateText,
    tool: module.tool,
    jsonSchema: module.jsonSchema,
  };
}
