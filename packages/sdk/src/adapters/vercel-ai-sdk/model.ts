import type {
  ToolCall,
  ToolCallingModel,
  ToolCallingModelRequest,
  ToolCallingResponse,
} from "../tool-calling";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
import { loadOptionalPeer } from "../shared/optionalPeer";
import { toDisplayText } from "../shared/coercion";
import { mapConversationMessages, normalizeConversationRole } from "../tool-calling/valueUtils";

interface VercelAISDKToolDefinition {
  description?: string;
  inputSchema: Record<string, unknown>;
}

type VercelAISDKGenerateText = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
type VercelAISDKToolFactory = (definition: VercelAISDKToolDefinition) => unknown;

interface VercelAISDKRuntime {
  generateText: VercelAISDKGenerateText;
  tool: VercelAISDKToolFactory;
}

export interface VercelAISDKToolCallingModelOptions {
  model: unknown;
  generateText?: VercelAISDKGenerateText;
  toolFactory?: VercelAISDKToolFactory;
}

/** {@link ToolCallingModel} backed by the Vercel AI SDK's `generateText`. */
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
        if (this.generateTextOverride && this.toolFactoryOverride) {
          return {
            generateText: this.generateTextOverride,
            tool: this.toolFactoryOverride,
          };
        }

        const runtime = await loadVercelAISDKRuntime();
        return {
          generateText: this.generateTextOverride ?? runtime.generateText,
          tool: this.toolFactoryOverride ?? runtime.tool,
        };
      },
    });
  }

  public async complete(request: ToolCallingModelRequest): Promise<ToolCallingResponse> {
    const runtime = await this.runtimeLoader.get();
    const tools = toVercelAISDKTools(request.tools, runtime.tool);

    const response = await runtime.generateText({
      model: this.model,
      ...(request.systemPrompt?.trim() ? { system: request.systemPrompt.trim() } : {}),
      messages: toVercelAISDKMessages(request),
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
    });

    return parseVercelAISDKResponse(response);
  }
}

function toVercelAISDKMessages(request: ToolCallingModelRequest): Array<Record<string, unknown>> {
  const messages = mapConversationMessages(request, toVercelAISDKMessage);

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
        output: result.output,
      })),
    });
  }

  return messages;
}

function toVercelAISDKMessage(entry: Record<string, unknown>): Record<string, unknown> | null {
  const role = normalizeConversationRole(entry.role);
  if (!role) {
    return null;
  }

  return {
    role,
    content: toDisplayText(entry.content),
  };
}

function toVercelAISDKTools(
  schemas: Array<Record<string, unknown>>,
  toolFactory: VercelAISDKToolFactory,
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

    tools[name] = toolFactory({
      ...(description ? { description } : {}),
      inputSchema: parameters && typeof parameters === "object" && !Array.isArray(parameters)
        ? parameters as Record<string, unknown>
        : { type: "object", properties: {}, required: [] },
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
  return loadOptionalPeer({
    feature: "VercelAISDKAdapter",
    packageName: "ai",
    importModule: () => import("ai"),
    expectedExports: "`generateText` and `tool`",
    select: (module) => {
      const generateText = module.generateText as VercelAISDKGenerateText | undefined;
      const tool = module.tool as VercelAISDKToolFactory | undefined;
      return generateText && tool ? { generateText, tool } : undefined;
    },
  });
}
