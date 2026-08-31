import { z, type ZodIssue } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { asErrorMessage, BandSdkError } from "../../core/errors";

/**
 * An extra tool an adapter exposes to its model alongside the platform tools.
 *
 * `name` is required and must be a non-empty string — it is what the model calls and what
 * the SDK looks the tool up by. `schema` must be a Zod **object** schema (`z.object({…})`),
 * because it is converted to a JSON Schema `object` for the provider's tool format; a bare
 * `z.string()` or `z.array()` has no properties to convert. Use `z.object({})` for a tool
 * that takes no arguments.
 */
export interface CustomToolDef {
  /** Zod object schema for the tool's arguments. Must be an object schema. */
  schema: z.AnyZodObject;
  /** Runs the tool. Receives the parsed arguments; may return anything serializable. */
  handler: (args: Record<string, unknown>) => unknown;
  /** Required, non-empty tool name the model calls. */
  name: string;
  /** Prompt-facing description of when the model should call this tool. */
  description?: string;
}

/** Thrown when a custom tool is declared without a usable name or schema. */
export class CustomToolDefinitionError extends BandSdkError {
  public constructor(message: string) {
    super(message);
    this.name = "CustomToolDefinitionError";
  }
}

/** Thrown when a model's arguments for a custom tool fail that tool's Zod schema. */
export class CustomToolValidationError extends BandSdkError {
  public readonly toolName: string;
  public readonly issues: string[];

  public constructor(toolName: string, issues: string[]) {
    super(`Invalid arguments for ${toolName}: ${issues.join(", ")}`);
    this.name = "CustomToolValidationError";
    this.toolName = toolName;
    this.issues = issues;
  }
}

/** Thrown when a custom tool's own handler throws; the original error is kept as the cause. */
export class CustomToolExecutionError extends BandSdkError {
  public readonly toolName: string;

  public constructor(toolName: string, cause: unknown) {
    super(`Custom tool ${toolName} failed: ${asErrorMessage(cause)}`, cause);
    this.name = "CustomToolExecutionError";
    this.toolName = toolName;
  }
}

function normalizeToolName(name: string, context: "definition" | "lookup"): string {
  const normalized = name.trim();
  if (!normalized) {
    const noun = context === "definition" ? "name" : "lookup name";
    throw new CustomToolDefinitionError(`Custom tool ${noun} must be a non-empty string.`);
  }

  return normalized;
}

export function getCustomToolName(def: CustomToolDef): string {
  return normalizeToolName(def.name, "definition");
}

export function customToolToOpenAISchema(def: CustomToolDef): Record<string, unknown> {
  const name = getCustomToolName(def);
  return {
    type: "function",
    function: {
      name,
      description: def.description ?? def.schema.description ?? "",
      parameters: toCleanJsonSchema(def.schema),
    },
  };
}

export function customToolToAnthropicSchema(def: CustomToolDef): Record<string, unknown> {
  const name = getCustomToolName(def);
  return {
    name,
    description: def.description ?? def.schema.description ?? "",
    input_schema: toCleanJsonSchema(def.schema),
  };
}

function toCleanJsonSchema(schema: z.AnyZodObject): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(schema, { target: "jsonSchema7" }) as Record<string, unknown>;
  delete jsonSchema["$schema"];
  delete jsonSchema["additionalProperties"];
  return jsonSchema;
}

export function customToolsToSchemas(
  tools: CustomToolDef[],
  format: "openai" | "anthropic",
): Record<string, unknown>[] {
  const converter = format === "openai" ? customToolToOpenAISchema : customToolToAnthropicSchema;
  return tools.map(converter);
}

export function findCustomTool(
  tools: CustomToolDef[],
  name: string,
): CustomToolDef | undefined {
  const normalizedName = normalizeToolName(name, "lookup");
  return tools.find((def) => getCustomToolName(def) === normalizedName);
}

export function findCustomToolInIndex(
  index: Map<string, CustomToolDef>,
  name: string,
): CustomToolDef | undefined {
  return index.get(normalizeToolName(name, "lookup"));
}

export function buildCustomToolIndex(tools: CustomToolDef[]): Map<string, CustomToolDef> {
  const index = new Map<string, CustomToolDef>();
  for (const def of tools) {
    const name = getCustomToolName(def);
    if (index.has(name)) {
      throw new CustomToolDefinitionError(`Duplicate custom tool name '${name}' is not allowed.`);
    }
    index.set(name, def);
  }
  return index;
}

export async function executeCustomTool(
  def: CustomToolDef,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  const toolName = getCustomToolName(def);
  const result = def.schema.safeParse(arguments_);

  if (!result.success) {
    const errors = result.error.issues.map(formatZodIssue);
    throw new CustomToolValidationError(toolName, errors);
  }

  try {
    const output = def.handler(result.data as Record<string, unknown>);
    if (output instanceof Promise) {
      return await output;
    }
    return output;
  } catch (error) {
    if (error instanceof CustomToolValidationError || error instanceof CustomToolExecutionError) {
      throw error;
    }
    throw new CustomToolExecutionError(toolName, error);
  }
}

function formatZodIssue(issue: ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "value";
  return `${path}: ${issue.message}`;
}
