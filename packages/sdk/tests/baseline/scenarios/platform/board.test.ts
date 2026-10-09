/** Board business rules are exercised on Band, rather than recreated in a local fake. */
import { describe, expect, it } from "vitest";

import { supportsCapability } from "../../../../src/contracts/capabilities";
import { AgentTools } from "../../../../src/runtime/tools/AgentTools";
import type { GetBoardArgs } from "../../../../src/contracts/dtos";
import { Agents } from "../../toolkit/agents";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

const SCENARIO = scenarioId(CATEGORY.platform, "board");
const NOT_FOUND = 404;
const UNPROCESSABLE = 422;
const OVERLONG_SUBJECT = "x".repeat(501);

function validationError(field: string) {
  return { statusCode: UNPROCESSABLE, body: { error: { code: "validation_error", details: { [field]: expect.any(Array) } } } };
}

describe(SCENARIO, () => {
  it("sets a goal, joins by status, paginates and archives tasks, and preserves Band's refusals", async () => {
    await using identity = await Agents.provision(SCENARIO, "board-owner");
    const profile = await identity.rest.getAgentMe();
    expect(supportsCapability(profile.featureFlags, "tasks"), "live board baseline requires ff_room_tasks").toBe(true);
    await using room = await Rooms.createAs(identity);
    const tools = new AgentTools({ roomId: room.id, rest: identity.rest, capabilities: { tasks: true } });

    expect(await tools.getBoard({})).toMatchObject({ goal_title: null, goal_summary: null });
    expect((await tools.listTasks({})).data).toEqual([]);
    await tools.setBoard({ goal_title: "Verify the board", goal_summary: "Exercise the real API" });
    expect(await tools.getBoard({})).toMatchObject({ goal_title: "Verify the board", goal_summary: "Exercise the real API" });

    const first = await tools.createTask({ subject: "First piece" });
    const second = await tools.createTask({ subject: "Second piece" });
    expect(first).toMatchObject({ number: expect.any(Number), assignments: [], overall_status: "pending" });
    const joined = await tools.updateTask({ id: `#${first.number}`, status: "in_progress", active_form: "Verifying the API" });
    expect(joined).toMatchObject({ overall_status: "in_progress", assignments: [{ assignee: { id: identity.id }, status: "in_progress", active_form: "Verifying the API" }] });

    const page = await tools.listTasks({ limit: 1 });
    expect(page.data).toHaveLength(1);
    expect(page.metadata).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
    const next = await tools.listTasks({ limit: 1, cursor: page.metadata.next_cursor! });
    expect(new Set([...page.data, ...next.data].map(({ id }) => id))).toEqual(new Set([first.id, second.id]));
    expect(next.metadata.has_more).toBe(false);

    await tools.updateTask({ id: first.id, comment: "Verified successfully" });
    expect(await tools.getTask({ id: `#${first.number}`, include: "history" })).toMatchObject({ history: expect.arrayContaining([{ event: "commented", actor: expect.objectContaining({ id: identity.id }), payload: { text: "Verified successfully" }, at: expect.any(String) }]), history_truncated: false });
    await tools.updateTask({ id: first.id, status: "completed", state: "archived" });
    expect((await tools.listTasks({})).data.map(({ id }) => id)).toEqual([second.id]);
    await expect(tools.updateTask({ id: first.id, status: "in_progress" })).rejects.toMatchObject({ statusCode: UNPROCESSABLE, body: { error: { code: "task_not_active" } } });

    await using other = await Agents.provision(SCENARIO, "other-owner");
    await using unjoined = await Rooms.createAs(other);
    const outsider = new AgentTools({ roomId: unjoined.id, rest: identity.rest, capabilities: { tasks: true } });
    await expect(outsider.getBoard({})).rejects.toMatchObject({ statusCode: NOT_FOUND });
    await expect(tools.createTask({ subject: OVERLONG_SUBJECT })).rejects.toMatchObject(validationError("/subject"));
    await expect(tools.getBoard({ include: "invalid" } as unknown as GetBoardArgs)).rejects.toMatchObject(validationError("/include"));
    await expect(tools.updateTask({ id: second.id })).rejects.toMatchObject({ statusCode: UNPROCESSABLE, body: { error: { code: "validation_error" } } });
  });
});
