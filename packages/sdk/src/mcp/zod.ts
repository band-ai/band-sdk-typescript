export function buildZodShape(
  z: typeof import("zod").z,
  properties: Record<string, unknown>,
  required: Set<string>,
): Record<string, import("zod").ZodType> {
  const shape: Record<string, import("zod").ZodType> = {};

  for (const [name, schema] of Object.entries(properties)) {
    const validator = jsonSchemaToZod(z, schema as Record<string, unknown>);
    shape[name] = required.has(name) ? validator : validator.optional();
  }

  return shape;
}

function jsonSchemaToZod(
  z: typeof import("zod").z,
  schema: Record<string, unknown>,
): import("zod").ZodType {
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
    return z.record(z.string(), z.unknown());
  }

  return z.unknown();
}
