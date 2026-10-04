import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildCustomToolIndex,
  CustomToolDefinitionError,
  type CustomToolDef,
  customToolToAnthropicSchema,
  customToolToOpenAISchema,
  customToolsToSchemas,
  executeCustomTool,
  findCustomTool,
  findCustomToolInIndex,
  getCustomToolName,
} from "../src/runtime/tools/customTools";

// -- Test fixtures --

const WeatherSchema = z.object({
  city: z.string().describe("City name"),
}).describe("Get current weather for a city.");

const CalculatorSchema = z.object({
  operation: z.string().describe("add, subtract, multiply, divide"),
  left: z.number(),
  right: z.number(),
}).describe("Perform math calculations.");

const SearchWebSchema = z.object({
  query: z.string().describe("Search query"),
  max_results: z.number().default(10).describe("Maximum results to return"),
});

const NoDescriptionSchema = z.object({
  value: z.string(),
});

async function asyncWeather(args: Record<string, unknown>): Promise<string> {
  return `Weather in ${args.city}: Sunny, 72F`;
}

function syncCalculator(args: Record<string, unknown>): string {
  const ops: Record<string, (a: number, b: number) => number> = {
    add: (a, b) => a + b,
    subtract: (a, b) => a - b,
    multiply: (a, b) => a * b,
    divide: (a, b) => a / b,
  };
  const result = ops[args.operation as string]!(args.left as number, args.right as number);
  return String(result);
}

async function failingTool(_args: Record<string, unknown>): Promise<string> {
  throw new Error("API unavailable");
}

// -- Tests --

describe("getCustomToolName", () => {
  it("returns the name as-is", () => {
    expect(getCustomToolName({ schema: WeatherSchema, handler: asyncWeather, name: "weather" })).toBe("weather");
    expect(getCustomToolName({ schema: CalculatorSchema, handler: syncCalculator, name: "calculator" })).toBe("calculator");
  });

  it("preserves exact name value", () => {
    expect(getCustomToolName({ schema: SearchWebSchema, handler: asyncWeather, name: "search_web" })).toBe("search_web");
    expect(getCustomToolName({ schema: NoDescriptionSchema, handler: asyncWeather, name: "MyTool" })).toBe("MyTool");
  });
});

describe("customToolToOpenAISchema", () => {
  it("produces correct structure", () => {
    const def: CustomToolDef = { schema: WeatherSchema, handler: asyncWeather, name: "weather" };
    const schema = customToolToOpenAISchema(def);

    expect(schema.type).toBe("function");
    expect(schema.function).toBeDefined();
    const fn = schema.function as Record<string, unknown>;
    expect(fn.name).toBe("weather");
    expect(fn.description).toBe("Get current weather for a city.");
    expect(fn.parameters).toBeDefined();
  });

  it("includes field definitions in parameters", () => {
    const def: CustomToolDef = { schema: CalculatorSchema, handler: syncCalculator, name: "calculator" };
    const schema = customToolToOpenAISchema(def);

    const params = (schema.function as Record<string, unknown>).parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, unknown>;
    expect(properties.operation).toBeDefined();
    expect(properties.left).toBeDefined();
    expect(properties.right).toBeDefined();
  });

  it("handles missing description", () => {
    const def: CustomToolDef = { schema: NoDescriptionSchema, handler: asyncWeather, name: "nodoc" };
    const schema = customToolToOpenAISchema(def);

    const fn = schema.function as Record<string, unknown>;
    expect(fn.description).toBe("");
  });
});

describe("customToolToAnthropicSchema", () => {
  it("produces correct structure", () => {
    const def: CustomToolDef = { schema: WeatherSchema, handler: asyncWeather, name: "weather" };
    const schema = customToolToAnthropicSchema(def);

    expect(schema.name).toBe("weather");
    expect(schema.description).toBe("Get current weather for a city.");
    expect(schema.input_schema).toBeDefined();
  });

  it("includes field definitions in input_schema", () => {
    const def: CustomToolDef = { schema: CalculatorSchema, handler: syncCalculator, name: "calculator" };
    const schema = customToolToAnthropicSchema(def);

    const inputSchema = schema.input_schema as Record<string, unknown>;
    const properties = inputSchema.properties as Record<string, unknown>;
    expect(properties.operation).toBeDefined();
    expect(properties.left).toBeDefined();
    expect(properties.right).toBeDefined();
  });

  it("handles missing description", () => {
    const def: CustomToolDef = { schema: NoDescriptionSchema, handler: asyncWeather, name: "nodoc" };
    const schema = customToolToAnthropicSchema(def);
    expect(schema.description).toBe("");
  });
});

describe("customToolsToSchemas", () => {
  const tools: CustomToolDef[] = [
    { schema: WeatherSchema, handler: asyncWeather, name: "weather" },
    { schema: CalculatorSchema, handler: syncCalculator, name: "calculator" },
  ];

  it("converts multiple tools to OpenAI format", () => {
    const schemas = customToolsToSchemas(tools, "openai");
    expect(schemas).toHaveLength(2);
    expect(schemas[0]!.type).toBe("function");
    expect((schemas[0]!.function as Record<string, unknown>).name).toBe("weather");
    expect((schemas[1]!.function as Record<string, unknown>).name).toBe("calculator");
  });

  it("converts multiple tools to Anthropic format", () => {
    const schemas = customToolsToSchemas(tools, "anthropic");
    expect(schemas).toHaveLength(2);
    expect(schemas[0]!.name).toBe("weather");
    expect(schemas[0]!.input_schema).toBeDefined();
    expect(schemas[1]!.name).toBe("calculator");
  });

  it("returns empty list for empty input", () => {
    expect(customToolsToSchemas([], "openai")).toEqual([]);
  });
});

describe("findCustomTool", () => {
  const tools: CustomToolDef[] = [
    { schema: WeatherSchema, handler: asyncWeather, name: "weather" },
    { schema: CalculatorSchema, handler: syncCalculator, name: "calculator" },
  ];

  it("finds tool by name", () => {
    const result = findCustomTool(tools, "calculator");
    expect(result).toBeDefined();
    expect(result!.handler).toBe(syncCalculator);
  });

  it("returns undefined for unknown tool", () => {
    expect(findCustomTool(tools, "unknown")).toBeUndefined();
  });

  it("returns undefined for empty list", () => {
    expect(findCustomTool([], "weather")).toBeUndefined();
  });

  it("normalizes lookup names by trimming surrounding whitespace", () => {
    expect(findCustomTool(tools, "  weather  ")).toEqual(tools[0]);
  });

  it("finds first match when duplicates exist", () => {
    const dupes: CustomToolDef[] = [
      { schema: WeatherSchema, handler: asyncWeather, name: "weather" },
      { schema: WeatherSchema, handler: failingTool, name: "weather" },
    ];
    const result = findCustomTool(dupes, "weather");
    expect(result!.handler).toBe(asyncWeather);
  });
});

describe("buildCustomToolIndex", () => {
  const tools: CustomToolDef[] = [
    { schema: WeatherSchema, handler: asyncWeather, name: "weather" },
    { schema: CalculatorSchema, handler: syncCalculator, name: "calculator" },
  ];

  it("normalizes index lookups with trimmed names", () => {
    const index = buildCustomToolIndex(tools);
    expect(findCustomToolInIndex(index, " calculator ")).toEqual(tools[1]);
  });

  it("rejects duplicate tool names", () => {
    const duplicateTools: CustomToolDef[] = [
      { schema: WeatherSchema, handler: asyncWeather, name: "weather" },
      { schema: WeatherSchema, handler: failingTool, name: "weather" },
    ];

    expect(() => buildCustomToolIndex(duplicateTools)).toThrow(CustomToolDefinitionError);
  });
});

describe("executeCustomTool", () => {
  it("executes async function", async () => {
    const def: CustomToolDef = { schema: WeatherSchema, handler: asyncWeather, name: "weather" };
    const result = await executeCustomTool(def, { city: "NYC" });
    expect(result).toBe("Weather in NYC: Sunny, 72F");
  });

  it("executes sync function", async () => {
    const def: CustomToolDef = { schema: CalculatorSchema, handler: syncCalculator, name: "calculator" };
    const result = await executeCustomTool(def, { operation: "add", left: 5, right: 3 });
    expect(result).toBe("8");
  });

  it("validates input and throws formatted error", async () => {
    const def: CustomToolDef = { schema: CalculatorSchema, handler: syncCalculator, name: "calculator" };
    await expect(executeCustomTool(def, { operation: "add" })).rejects.toThrow(
      "Invalid arguments for calculator",
    );
  });

  it("includes field names in validation error", async () => {
    const def: CustomToolDef = { schema: WeatherSchema, handler: asyncWeather, name: "weather" };
    await expect(executeCustomTool(def, {})).rejects.toThrow("city");
  });

  it("propagates handler errors", async () => {
    const def: CustomToolDef = { schema: WeatherSchema, handler: failingTool, name: "weather" };
    await expect(executeCustomTool(def, { city: "NYC" })).rejects.toThrow("API unavailable");
  });

  it("passes validated object to handler", async () => {
    const received: Record<string, unknown>[] = [];
    const def: CustomToolDef = {
      schema: CalculatorSchema,
      handler: (args) => { received.push(args); return "captured"; },
      name: "calculator",
    };

    await executeCustomTool(def, { operation: "add", left: 1, right: 2 });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ operation: "add", left: 1, right: 2 });
  });

  it("handles optional fields with defaults", async () => {
    const received: Record<string, unknown>[] = [];
    const def: CustomToolDef = {
      schema: SearchWebSchema,
      handler: (args) => { received.push(args); return "searched"; },
      name: "search",
    };

    await executeCustomTool(def, { query: "test" });
    expect(received[0]!.max_results).toBe(10);
  });

  it("uses explicit description over schema description", () => {
    const def: CustomToolDef = {
      schema: WeatherSchema,
      handler: asyncWeather,
      name: "weather",
      description: "Custom description override",
    };
    const schema = customToolToOpenAISchema(def);
    expect((schema.function as Record<string, unknown>).description).toBe("Custom description override");
  });
});
