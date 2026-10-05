import type { TurnTools } from "../core/turn";
import { asOptionalRecord } from "../adapters/shared/coercion";
import {
  CustomToolDefinitionError,
  customToolToOpenAISchema,
  executeCustomTool,
  getCustomToolName,
  type CustomToolDef,
} from "../runtime/tools/customTools";
import { errorResult, ROOM_ID_ARG, scopeToRoom, successResult, type McpToolRegistration } from "./registrations";

/** Registered once; resolve the active room on each call to record the correct turn. */
export function buildCustomMcpRegistrations(
  customTools: CustomToolDef[],
  toolsForRoom: (roomId: string) => TurnTools | undefined,
): McpToolRegistration[] {
  return customTools.map((customTool) => {
    const name = getCustomToolName(customTool);
    const schema = customToolToOpenAISchema(customTool);
    const functionSchema = asOptionalRecord(schema.function) ?? {};
    const parameters = asOptionalRecord(functionSchema.parameters) ?? {};
    const properties = asOptionalRecord(parameters.properties) ?? {};
    if (Object.hasOwn(properties, ROOM_ID_ARG)) {
      throw new CustomToolDefinitionError(`Custom tool '${name}' can't take '${ROOM_ID_ARG}': room-scoped MCP tools use it for routing.`);
    }
    const required = Array.isArray(parameters.required)
      ? parameters.required.filter((value): value is string => typeof value === "string")
      : [];

    return scopeToRoom(
      {
        name,
        description: typeof functionSchema.description === "string" ? functionSchema.description : "",
        inputSchema: { type: "object", properties, required },
      },
      toolsForRoom,
      async (tools, args) => {
        try {
          return successResult(await executeCustomTool(customTool, args, tools.turn));
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    );
  });
}
