import { Band } from "@band-ai/rest-client";
import { describe, expect, it } from "vitest";

import { UnsupportedFeatureError, ValidationError } from "../../src/core/errors";
import { AgentTools } from "../../src/runtime/tools/AgentTools";
import { BandPlatform } from "./support/bandPlatform";

/** Ported from band-sdk-python/tests/identifiers.py; these are unsafe route segments. */
const INVALID_IDS = ["", " ", "\t", "\n", " id", "id ", "id\n", ".", "..", "/", "\\", "?", "#", "%2F", "%23", "../memories/", "id?x=1", "id#x", "id\0", "é"];
const ID_RULE = "ID must contain only ASCII letters, digits, underscores or hyphens";

function board() {
  const platform = BandPlatform.host([], { featureFlags: { ff_room_tasks: true } });
  platform.rest.addRoom("room");
  const tools = new AgentTools({ roomId: "room", rest: platform.rest, capabilities: { tasks: true } });
  return { platform, tools };
}

describe("room board tool flows", () => {
  it("reads the goal and tasks and sends normalized references to Band", async () => {
    const { platform, tools } = board();
    expect(await tools.getBoard({})).toMatchObject({ goal_title: null, goal_summary: null });
    await tools.setBoard({ goal_title: "Ship the feature", goal_summary: "Build and verify it" });
    expect(await tools.getBoard({})).toMatchObject({ goal_title: "Ship the feature" });
    await tools.createTask({ subject: "First piece" });
    await tools.createTask({ subject: "Second piece" });
    const third = await tools.createTask({ subject: "Replacement", supersedes_id: "#1" });
    expect(platform.rest.boardCalls.entries.at(-1)).toMatchObject({ call: "createChatTask", args: { supersedes_id: "1" } });
    expect(await tools.getTask({ id: "#3" })).toEqual(third);
    expect(await tools.getTask({ id: "3" })).toEqual(third);
    expect(await tools.getTask({ id: third.id })).toEqual(third);
    expect((await tools.listTasks({})).data).toHaveLength(3);
    await tools.updateTask({ id: "#3", status: "in_progress", active_form: "Building", comment: "Started" });
    expect(platform.rest.boardCalls.entries.at(-1)).toMatchObject({ call: "updateChatTask", id: "3" });
    expect(await tools.getTask({ id: "3", include: "history" })).toMatchObject({
      assignments: [{ status: "in_progress", active_form: "Building" }],
      history: [{ event: "commented", payload: { text: "Started" } }],
    });
  });

  it.each(INVALID_IDS)("refuses unsafe task reference %j before a REST request", async (id) => {
    const { platform, tools } = board();
    for (const operation of [
      () => tools.getTask({ id }),
      () => tools.updateTask({ id, status: "in_progress" }),
      () => tools.createTask({ subject: "Replacement", supersedes_id: id }),
    ]) {
      const result = operation();
      await expect(result).rejects.toBeInstanceOf(ValidationError);
      await expect(result).rejects.toThrow(ID_RULE);
    }
    expect(platform.rest.boardCalls.entries).toEqual([]);
  });

  it("preserves Band's room membership 404", async () => {
    const { platform } = board();
    const tools = new AgentTools({ roomId: "unjoined", rest: platform.rest, capabilities: { tasks: true } });
    await expect(tools.getBoard({})).rejects.toBeInstanceOf(Band.NotFoundError);
    expect(platform.rest.refused.entries).toEqual([{ roomId: "unjoined", call: "getChatBoard", attempt: undefined }]);
  });

  it("refuses direct and dispatched task calls when capability is disabled", async () => {
    const { platform } = board();
    const tools = new AgentTools({ roomId: "room", rest: platform.rest });
    await expect(tools.createTask({ subject: "Must not write" })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(await tools.executeToolCall("band_create_task", { subject: "Must not write" })).toMatchObject({ ok: false, message: "Tasks is disabled by runtime capabilities" });
    expect(platform.rest.boardCalls.entries).toEqual([]);
  });
});
