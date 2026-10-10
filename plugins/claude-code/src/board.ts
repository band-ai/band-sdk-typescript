import type { TaskTools } from "@band-ai/sdk";
import type { McpToolRegistration } from "@band-ai/sdk/mcp";
import { AgentTools, getToolDescription, TOOL_MODELS } from "@band-ai/sdk/runtime";

import { requiredString, toolResult, type ToolContext } from "./tools";

/** Bare names keep the SDK's descriptions and direct calls, including Band's error bodies. */
export const BOARD_TOOL = {
  get_board: {
    sdkName: "band_get_board",
    call: (tools: TaskTools, args: Record<string, unknown>) => tools.getBoard(args),
  },
  list_tasks: {
    sdkName: "band_list_tasks",
    call: (tools: TaskTools, args: Record<string, unknown>) => tools.listTasks(args),
  },
  set_board: {
    sdkName: "band_set_board",
    call: (tools: TaskTools, args: Record<string, unknown>) => tools.setBoard(args),
  },
  create_task: {
    sdkName: "band_create_task",
    call: (tools: TaskTools, args: Record<string, unknown>) => tools.createTask({ ...args, subject: args.subject as string }),
  },
  update_task: {
    sdkName: "band_update_task",
    call: (tools: TaskTools, args: Record<string, unknown>) => tools.updateTask({ ...args, id: args.id as string }),
  },
  get_task: {
    sdkName: "band_get_task",
    call: (tools: TaskTools, args: Record<string, unknown>) => tools.getTask({ ...args, id: args.id as string }),
  },
} as const;

export function boardTools(context: ToolContext): McpToolRegistration[] {
  return Object.entries(BOARD_TOOL).map(([name, entry]) => {
    const model = TOOL_MODELS[entry.sdkName];
    return {
      name,
      description: getToolDescription(entry.sdkName),
      inputSchema: {
        type: "object",
        properties: {
          ...model.properties,
          room_id: { type: "string", description: "The Band room whose board to use." },
        },
        required: [...model.required, "room_id"],
      },
      execute: async (args) => toolResult(name, context, async () => {
        const { room_id: _roomId, ...taskArgs } = args;
        const tools = new AgentTools({
          roomId: requiredString(args, "room_id"),
          rest: context.link.rest,
          logger: context.logger,
          capabilities: { tasks: true },
        });
        return JSON.stringify(await entry.call(tools, taskArgs));
      }),
    };
  });
}
