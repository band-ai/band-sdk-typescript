import type { ZodType } from "zod";

export function buildZodShape(
  z: typeof import("zod").z,
  properties: Record<string, unknown>,
  required: Set<string>,
): Record<string, ZodType> {
  const shape: Record<string, ZodType> = {};

  for (const [name, schema] of Object.entries(properties)) {
    const validator = jsonSchemaToZod(z, schema as Record<string, unknown>);
    shape[name] = required.has(name) ? validator : validator.optional();
  }

  return shape;
}

// The description is how a model learns what a parameter means; dropping it publishes bare names and types.
function jsonSchemaToZod(
  z: typeof import("zod").z,
  schema: Record<string, unknown>,
): ZodType {
  const validator = typedValidator(z, schema);
  return typeof schema.description === "string" ? validator.describe(schema.description) : validator;
}

function typedValidator(
  z: typeof import("zod").z,
  schema: Record<string, unknown>,
): ZodType {
  const type = schema.type;

  if (type === "string") {
    if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === "string")) {
      const values = schema.enum;
      if (values.length > 0) {
        return z.enum(values as [string, ...string[]]);
      }
    }
    return z.string();
  }

  if (type === "integer" || type === "number") {
    return z.number();
  }

  if (type === "boolean") {
    return z.boolean();
  }

  if (type === "array") {
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === "object") {
      return z.array(jsonSchemaToZod(z, itemSchema as Record<string, unknown>));
    }
    return z.array(z.unknown());
  }

  if (type === "object") {
    // Not z.record: the Agent SDK's bundled JSON-schema converter can't render one, which fails its whole tools/list.
    // Loose, so keys beyond the declared properties still pass through.
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    return z.looseObject(buildZodShape(z, properties, new Set(required)));
  }

  return z.unknown();
}
