import { describe, expect, it, vi } from "vitest";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { StubRestApi } from "../src/testing/StubRestApi";
import { buildRoomScopedRegistrations } from "../src/mcp/registrations";
import { UnsupportedFeatureError } from "../src/core/errors";

const taskNames = ["band_get_board", "band_set_board", "band_list_tasks", "band_create_task", "band_get_task", "band_update_task"];

describe("board capability boundary", () => {
  it("refuses disabled direct and dispatched writes without REST", async () => {
    const rest = Object.assign(new StubRestApi(), { createChatTask: vi.fn() });
    const tools = new AgentTools({ roomId: "room", rest });
    await expect(tools.createTask({ subject: "test" })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    const result = await tools.executeToolCall("band_create_task", { subject: "test" });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("disabled") });
    expect(rest.createChatTask).not.toHaveBeenCalled();
    expect(tools.getToolSchemas("anthropic").map((schema) => schema.name).filter((name) => taskNames.includes(String(name)))).toEqual([]);
  });

  it("registers all six with room ids only when requested", () => {
    const tools = new AgentTools({ roomId: "room", rest: new StubRestApi() });
    const resolve = () => tools;
    expect(buildRoomScopedRegistrations(resolve).map((entry) => entry.name).filter((name) => taskNames.includes(name))).toEqual([]);
    const registrations = buildRoomScopedRegistrations(resolve, { enableTaskTools: true });
    for (const name of taskNames) {
      expect(registrations.find((entry) => entry.name === name)?.inputSchema.required).toContain("room_id");
    }
  });
});
