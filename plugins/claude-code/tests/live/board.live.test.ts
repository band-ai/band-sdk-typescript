import { describe, expect, it, onTestFinished } from "vitest";
import type { WireTaskPage } from "@band-ai/sdk/rest";
import { BOARD_TOOL } from "../../src/board";
import { AGENT_SELECT_ENV, writeSavedAgents } from "../../src/config";
import { TOOL } from "../../src/tools";
import { Agents, type AgentIdentity } from "../../../../packages/sdk/tests/baseline/toolkit/agents";
import { liveRun, warnTeardown } from "../../../../packages/sdk/tests/baseline/toolkit/liveRun";
import { history, MESSAGE_TYPE } from "../../../../packages/sdk/tests/baseline/toolkit/observeMessages";
import { deleteRoomsBulk } from "../../../../packages/sdk/tests/integration/support/liveHarness";
import { ClaudeCodeDirs } from "../support/claudeCodeDirs";
import { callTool } from "../support/channelClient";
import { PluginProcess } from "./support/pluginProcess";

function saved(identity: AgentIdentity): ClaudeCodeDirs {
  const dirs = new ClaudeCodeDirs();
  writeSavedAgents(dirs.dataDir, { main: { agentId: identity.id, apiKey: identity.apiKey, handle: null } });
  return dirs;
}

async function callOk(plugin: PluginProcess, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await callTool(plugin.client, name, args);
  expect(result.isError, result.text).toBe(false);
  return result.text;
}

async function connected(dirs: ClaudeCodeDirs): Promise<PluginProcess> {
  const plugin = await PluginProcess.start({ ...dirs.env("board-session"), [AGENT_SELECT_ENV]: "main" });
  await plugin.connected();
  expect((await plugin.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([...Object.values(TOOL), ...Object.keys(BOARD_TOOL)].sort());
  return plugin;
}

describe("the lead and worker board workflow on Band", () => {
  it("delegates by mention, joins by the worker's own status, completes and wraps up", async () => {
    const lead = await Agents.provision("claude-code", "board-lead");
    const worker = await Agents.provision("claude-code", "board-worker");
    for (const agent of [lead, worker]) {
      const me = await agent.rest.getAgentMe();
      expect(me.featureFlags?.ff_room_tasks, `ff_room_tasks must be on for ${agent.name}; this live lane cannot skip`).toBe(true);
    }
    using leadDirs = saved(lead);
    using workerDirs = saved(worker);
    await using leadPlugin = await connected(leadDirs);
    await using workerPlugin = await connected(workerDirs);
    const workerHandle = await worker.handle();
    const { env } = await liveRun();
    const owner = (await lead.rest.getAgentMe()).ownerUuid;
    expect(owner).toBeTruthy();
    const opened = await callOk(leadPlugin, TOOL.openRoom, { participants: [workerHandle, owner], new: true });
    const roomId = /\(room_id ([^)]+)\)/.exec(opened)?.[1];
    expect(roomId, opened).toBeTruthy();
    onTestFinished(async () => {
      await deleteRoomsBulk(env.restUrl, env.userApiKey, [roomId!]).catch(warnTeardown("delete board room"));
    });
    const roomArgs = { room_id: roomId! };
    await callOk(leadPlugin, "set_board", { ...roomArgs, goal_title: "Verify collaboration", goal_summary: "A worker reports its own progress and completion." });
    const task = JSON.parse(await callOk(leadPlugin, "create_task", { ...roomArgs, subject: "Report successful board coordination" })) as { number: number; assignments: unknown[] };
    expect(task.assignments).toEqual([]);
    await callOk(leadPlugin, TOOL.send, { ...roomArgs, content: `Please take #${task.number} and report completion.`, mentions: [workerHandle] });
    const assignedMessage = (await history({ id: roomId! }, MESSAGE_TYPE.Text)).find((message) => message.senderId === lead.id);
    expect(assignedMessage).toBeDefined();
    const push = await workerPlugin.pushOf(assignedMessage!.id);
    expect(push.meta.room_id).toBe(roomId);
    const board = JSON.parse(await callOk(workerPlugin, "get_board", roomArgs));
    expect(board.goal_title).toBe("Verify collaboration");
    const tasks = JSON.parse(await callOk(workerPlugin, "list_tasks", roomArgs)) as WireTaskPage;
    expect(tasks.data.map((entry) => entry.number)).toContain(task.number);
    await callOk(workerPlugin, "update_task", { ...roomArgs, id: `#${task.number}`, status: "in_progress", active_form: "Checking collaboration" });
    await callOk(workerPlugin, "update_task", { ...roomArgs, id: `#${task.number}`, status: "completed" });
    await callOk(workerPlugin, TOOL.reply, { message_id: push.meta.message_id, content: `#${task.number} completed.` });
    const response = (await history({ id: roomId! }, MESSAGE_TYPE.Text)).find((message) => message.senderId === worker.id);
    expect(response).toBeDefined();
    await leadPlugin.pushOf(response!.id);
    const completed = JSON.parse(await callOk(leadPlugin, "list_tasks", roomArgs)) as WireTaskPage;
    expect(completed.data).toEqual([expect.objectContaining({ number: task.number, overall_status: "completed", assignments: [expect.objectContaining({ assignee: expect.objectContaining({ id: worker.id }), status: "completed" })] })]);
    await callOk(leadPlugin, TOOL.send, { ...roomArgs, content: `Board work completed with @${workerHandle}.`, mentions: [workerHandle] });
    const posted = await history({ id: roomId! }, MESSAGE_TYPE.Text);
    expect(posted.filter((message) => message.senderId === lead.id).at(-1)).toMatchObject({ mentionIds: [worker.id] });
  });
});
