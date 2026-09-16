import { z } from "zod";

export interface CustomToolDef {
  schema: z.ZodObject;
  handler: (args: Record<string, unknown>) => unknown;
  name: string;
  description?: string;
}

export class CustomToolDefinitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CustomToolDefinitionError";
  }
}

export class CustomToolValidationError extends Error {
  public readonly toolName: string;
  public readonly issues: string[];

  public constructor(toolName: string, issues: string[]) {
    super(`Invalid arguments for ${toolName}: ${issues.join(", ")}`);
    this.name = "CustomToolValidationError";
    this.toolName = toolName;
    this.issues = issues;
  }
}

export class CustomToolExecutionError extends Error {
  public readonly toolName: string;
  public readonly cause: unknown;

  public constructor(toolName: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Custom tool ${toolName} failed: ${message}`);
    this.name = "CustomToolExecutionError";
    this.toolName = toolName;
    this.cause = cause;
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

function toCleanJsonSchema(schema: z.ZodObject): Record<string, unknown> {
  // unrepresentable: "any" keeps schemas with JSON-unrepresentable field types
  // (bigint, symbol, instanceof, ...) from throwing, at the cost of emitting {}
  // for those fields — the LLM then receives no type constraint for them.
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
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
    const output = def.handler(result.data);
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

function formatZodIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "value";
  return `${path}: ${issue.message}`;
}
