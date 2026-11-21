import { z } from "zod";

import type {
  ToolCall,
  ToolCallingModel,
  ToolCallingModelOptions,
  ToolCallingModelRequest,
  ToolCallingResponse,
} from "../tool-calling";
import { UnsupportedFeatureError } from "../../core/errors";
import { LazyAsyncValue } from "../shared/lazyAsyncValue";
import { toDisplayText } from "../shared/coercion";
import { mapConversationMessages, normalizeConversationRole } from "../tool-calling/valueUtils";

interface VercelAISDKToolDefinition {
  description?: string;
  inputSchema: unknown;
}

type VercelAISDKGenerateText = (params: Record<string, unknown>) => Promise<unknown>;
type VercelAISDKToolFactory = (definition: VercelAISDKToolDefinition) => unknown;

interface VercelAISDKRuntime {
  generateText: VercelAISDKGenerateText;
  tool: VercelAISDKToolFactory;
}

const functionSchema = <T extends (...args: never[]) => unknown>() =>
  z.custom<T>((value) => typeof value === "function");

/** The parts of the `ai` module the adapter calls; a module without them is not a usable `ai`. */
const aiModuleSchema = z.object({
  generateText: functionSchema<VercelAISDKGenerateText>(),
  tool: functionSchema<VercelAISDKToolFactory>(),
  jsonSchema: functionSchema<(schema: Record<string, unknown>) => unknown>(),
});

/** What the adapter reads from a Band tool schema (OpenAI function format). */
const bandToolSchema = z.object({
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

const EMPTY_INPUT_SCHEMA: Record<string, unknown> = { type: "object", properties: {}, required: [] };

/** What the adapter reads from one `generateText` tool call. */
const generatedToolCall = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()).catch({}),
  invalid: z.boolean().optional(),
  error: z.unknown().optional(),
});

const generatedResponse = z.object({
  text: z.string().optional().catch(undefined),
  toolCalls: z.array(z.unknown()).optional().catch(undefined),
});

/** A tool result as `ai` takes it: typed, never the bare value. */
type VercelAISDKToolOutput = { type: "text"; value: string } | { type: "json"; value: z.infer<ReturnType<typeof z.json>> };

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

  public async complete(request: ToolCallingModelRequest, options?: ToolCallingModelOptions): Promise<ToolCallingResponse> {
    const runtime = await this.runtimeLoader.get();
    const tools = toVercelAISDKTools(request.tools, runtime.tool);

    const response = await runtime.generateText({
      model: this.model,
      ...(request.systemPrompt?.trim() ? { system: request.systemPrompt.trim() } : {}),
      messages: toVercelAISDKMessages(request),
      // The runtime's turn-identity and roster notices are system-role messages inside the conversation; `ai` 7 rejects those by default.
      allowSystemInMessages: true,
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
      abortSignal: options?.signal,
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
        output: toVercelAISDKToolOutput(result.output),
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

function toVercelAISDKToolOutput(output: unknown): VercelAISDKToolOutput {
  if (typeof output === "string") {
    return { type: "text", value: output };
  }

  const json = z.json().safeParse(output);
  return json.success ? { type: "json", value: json.data } : { type: "text", value: toDisplayText(output) };
}

function toVercelAISDKTools(
  schemas: Array<Record<string, unknown>>,
  toolFactory: VercelAISDKToolFactory,
): Record<string, unknown> {
  const tools: Record<string, unknown> = {};

  for (const schema of schemas) {
    const parsed = bandToolSchema.safeParse(schema);
    if (!parsed.success) {
      continue;
    }

    const { name, description, parameters } = parsed.data.function;
    tools[name] = toolFactory({
      ...(description ? { description } : {}),
      inputSchema: parameters ?? EMPTY_INPUT_SCHEMA,
    });
  }

  return tools;
}

function parseVercelAISDKResponse(response: unknown): ToolCallingResponse {
  const { text: rawText, toolCalls: rawToolCalls } = generatedResponse.parse(response);
  const text = rawText?.trim() ?? "";
  const toolCalls = parseVercelAISDKToolCalls(rawToolCalls ?? []);

  return {
    ...(text ? { text } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function parseVercelAISDKToolCalls(raw: unknown[]): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  for (const value of raw) {
    const parsed = generatedToolCall.safeParse(value);
    if (!parsed.success) {
      continue;
    }

    const { toolCallId, toolName, input, invalid, error } = parsed.data;
    const parseError = invalid === true
      ? (error instanceof Error ? error.message : (typeof error === "string" ? error : "Vercel AI SDK returned an invalid tool call."))
      : undefined;

    toolCalls.push({
      id: toolCallId,
      name: toolName,
      input,
      ...(parseError ? { inputParseError: parseError } : {}),
    });
  }

  return toolCalls;
}

async function loadVercelAISDKRuntime(): Promise<VercelAISDKRuntime> {
  const missing = (cause?: unknown): UnsupportedFeatureError => new UnsupportedFeatureError(
    `VercelAISDKAdapter requires optional dependency "ai". Install it with "pnpm add ai".${cause === undefined ? "" : ` (${cause instanceof Error ? cause.message : String(cause)})`}`,
  );

  const imported: unknown = await import("ai").catch((error: unknown) => {
    throw missing(error);
  });
  const parsed = aiModuleSchema.safeParse(imported);
  if (!parsed.success) {
    throw missing();
  }

  const { generateText, tool, jsonSchema } = parsed.data;
  return {
    generateText,
    // `tool()` takes a Schema or Zod type, not the raw JSON Schema the platform tools carry.
    tool: (definition) => tool({ ...definition, inputSchema: jsonSchema(z.record(z.string(), z.unknown()).parse(definition.inputSchema)) }),
  };
}
