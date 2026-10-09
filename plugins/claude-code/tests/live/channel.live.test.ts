/**
 * The built plugin against the live platform, with an MCP client in Claude
 * Code's place and no LLM: what Band delivers is pushed, what the client calls
 * posts back, each agent is held by one session at a time, and each session
 * connects as the agent it selects.
 */
import { describe, expect, it, onTestFinished } from "vitest";

import { CHANNEL_CAPABILITY, EXIT_FAILED, EXIT_OK } from "../../src/channel";
import { writeSavedAgents } from "../../src/config";
import type { FoundRoom } from "../../src/rooms";
import { TOOL } from "../../src/tools";
import { deleteRoomsBulk } from "../../../../packages/sdk/tests/integration/support/liveHarness";
import { Agents, type AgentIdentity } from "../../../../packages/sdk/tests/baseline/toolkit/agents";
import { liveRun, warnTeardown } from "../../../../packages/sdk/tests/baseline/toolkit/liveRun";
import { DELIVERY_STATUS, observeAgent } from "../../../../packages/sdk/tests/baseline/toolkit/observeDelivery";
import { history, MESSAGE_TYPE, observeRoom, REPLY_WAIT } from "../../../../packages/sdk/tests/baseline/toolkit/observeMessages";
import { ACTIVITY_EVENT, Rooms, type ActivityFrame, type Room } from "../../../../packages/sdk/tests/baseline/toolkit/rooms";
import { callTool } from "../support/channelClient";
import { ClaudeCodeDirs } from "../support/claudeCodeDirs";
import { agentsCommand, PluginProcess } from "./support/pluginProcess";

const CONFLICT_CODE = "connection_conflict";

async function agentInRoom(label: string): Promise<{ identity: AgentIdentity; room: Room }> {
  const identity = await Agents.provision("claude-code", label);
  const room = await Rooms.create();
  await Rooms.addParticipant(room, identity);
  return { identity, room };
}

/** Directories in which `identity` is the one agent saved, as `/band:agents add` leaves them. */
function savedAs(identity: AgentIdentity, name = "main"): ClaudeCodeDirs {
  const dirs = new ClaudeCodeDirs();
  writeSavedAgents(dirs.dataDir, { [name]: { agentId: identity.id, apiKey: identity.apiKey, handle: null } });
  return dirs;
}

/** Calls `name` as Claude would, and returns its text; a tool error fails the test. */
async function callOk(plugin: PluginProcess, name: string, args: Record<string, unknown>): Promise<string> {
  const reply = await callTool(plugin.client, name, args);
  expect(reply.isError, reply.text).toBe(false);
  return reply.text;
}

/** Deletes a room the agent created once the test ends, as the user, who must be in it. */
function deletedWithTest(roomId: string): void {
  onTestFinished(async () => {
    const { env } = await liveRun();
    await deleteRoomsBulk(env.restUrl, env.userApiKey, [roomId]).catch(warnTeardown(`delete room ${roomId}`));
  });
}

/**
 * Resolves with the agent's next `event` frame after the first `from` in the room's activity log.
 * Band flashes the indicator on every inbound message, so a wait starts from where its step happened.
 */
function nextActivity(room: Room, identity: AgentIdentity, event: ActivityFrame["event"], from: number): Promise<ActivityFrame> {
  return room.activity.next((frame) => frame.agentId === identity.id && frame.event === event, from);
}

/** The room `open_room` reported. */
function roomIdIn(text: string): string {
  const roomId = /\(room_id ([^)]+)\)/.exec(text)?.[1];
  expect(roomId, text).toBeDefined();
  return roomId!;
}

/** Resolves once `plugin` is connected to Band: a mention posted now reaches it. */
async function expectServing(plugin: PluginProcess, room: Room, identity: AgentIdentity, text: string): Promise<void> {
  const sent = await Rooms.sendMention(room, identity, text);
  expect((await plugin.pushOf(sent.id)).meta.room_id).toBe(room.id);
}

describe("the Claude Code plugin on the live platform", () => {
  it("pushes a mention, shows the agent working, replies by message id, and frees the agent when Claude Code exits", async () => {
    const { identity, room } = await agentInRoom("session");
    using dirs = savedAs(identity);
    const plugin = await PluginProcess.start(dirs.env("session-1"));

    expect(plugin.client.getServerCapabilities()?.experimental).toEqual({ [CHANNEL_CAPABILITY]: {} });
    const { tools } = await plugin.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.values(TOOL).sort());

    const sent = await Rooms.sendMention(room, identity, "ping");
    const push = await plugin.pushOf(sent.id);
    await nextActivity(room, identity, ACTIVITY_EVENT.started, room.activity.entries.length);
    expect(push.meta).toMatchObject({ room_id: room.id, message_id: sent.id, sender_role: "owner", sender_type: "User" });
    expect((await observeAgent(identity, room).untilProcessed(sent)).status).toBe(DELIVERY_STATUS.processed);

    await callOk(plugin, TOOL.reply, { message_id: push.meta.message_id, content: "pong" });
    const afterReply = room.activity.entries.length;
    // The platform stores the reply behind its mention token.
    const posted = await observeRoom(room).untilReplyMatching(identity, (message) => message.content.endsWith(" pong"));
    expect(posted.kind).toBe(REPLY_WAIT.reply);
    await nextActivity(room, identity, ACTIVITY_EVENT.stopped, afterReply);

    expect((await plugin.leave()).code).toBe(EXIT_OK);
    await using next = await PluginProcess.start(dirs.env("session-2"));
    await expectServing(next, room, identity, "still there?");
  });

  it("opens a room with another agent and the owner, reuses it, posts there, and posts to a room no message came from", async () => {
    const { identity, room } = await agentInRoom("rooms");
    const peer = await Agents.provision("claude-code", "rooms-peer");
    using dirs = savedAs(identity);
    await using plugin = await PluginProcess.start(dirs.env("session-1"));
    const peerHandle = await peer.handle();
    const [owner] = (await Rooms.participantIds(room)).filter((id) => id !== identity.id);

    const created = await callOk(plugin, TOOL.openRoom, { participants: [peerHandle, owner] });
    const roomId = roomIdIn(created);
    // The owner in the room lets the user delete it.
    deletedWithTest(roomId);
    expect(created).toMatch(/^Created /);
    expect(created).toContain(`@${peerHandle}: invited`);
    expect(await callOk(plugin, TOOL.openRoom, { participants: [peerHandle, owner] })).toMatch(new RegExp(`^Reused '.*' \\(room_id ${roomId}\\)\\.$`));

    await callOk(plugin, TOOL.send, { room_id: roomId, content: "let's start", mentions: [peerHandle] });
    const posted = (await history({ id: roomId }, MESSAGE_TYPE.Text)).filter((message) => message.senderId === identity.id);
    expect(posted).toEqual([expect.objectContaining({ mentionIds: [peer.id] })]);
    expect(posted[0]?.content.endsWith(" let's start")).toBe(true);

    const found = JSON.parse(await callOk(plugin, TOOL.findRooms, { participants: [peer.name] })) as FoundRoom[];
    expect(found.map((match) => match.room_id)).toEqual([roomId]);

    await callOk(plugin, TOOL.send, { room_id: room.id, content: "unprompted", mentions: [owner] });
    // Nothing was posted in the room before, so wait on its observer's frames rather than for a reply.
    const unprompted = await room.messages.next((message) => message.sender_id === identity.id);
    expect(unprompted.content.endsWith(" unprompted")).toBe(true);
  });

  it("clears the working indicator when Claude Code stops the server, and exits 0", async () => {
    const { identity, room } = await agentInRoom("interrupt");
    using dirs = savedAs(identity);
    const plugin = await PluginProcess.start(dirs.env("session-1"));
    const sent = await Rooms.sendMention(room, identity, "working?");
    await plugin.pushOf(sent.id);
    await nextActivity(room, identity, ACTIVITY_EVENT.started, room.activity.entries.length);

    const beforeStop = room.activity.entries.length;
    expect((await plugin.interrupt()).code).toBe(EXIT_OK);

    await nextActivity(room, identity, ACTIVITY_EVENT.stopped, beforeStop);
  });

  it("refuses a second session while the first holds the agent", async () => {
    const { identity, room } = await agentInRoom("conflict");
    using dirs = savedAs(identity);
    await using first = await PluginProcess.start(dirs.env("session-1"));
    await expectServing(first, room, identity, "first");

    const second = await PluginProcess.start(dirs.env("session-2"));
    const exit = await second.exited;

    expect(exit.code).toBe(EXIT_FAILED);
    expect(exit.stderr).toContain(CONFLICT_CODE);
    await expectServing(first, room, identity, "first still");
  });

  it("connects each session as the agent it selects, and tells a refused one that every agent is taken", async () => {
    const { env } = await liveRun();
    const { identity: main, room } = await agentInRoom("main");
    using dirs = savedAs(main);
    const docs = await Agents.provision("claude-code", "docs");
    await Rooms.addParticipant(room, docs);
    const added = await agentsCommand(...dirs.cliContext, "add", docs.id, docs.apiKey, "docs", ...(env.wsUrl ? ["--ws-url", env.wsUrl] : []));
    expect(added).toContain(`Saved "docs" (@${await docs.handle()})`);

    await using first = await PluginProcess.start(dirs.env("session-1", "main"));
    await using second = await PluginProcess.start(dirs.env("session-2", "docs"));
    await expectServing(first, room, main, "main");
    await expectServing(second, room, docs, "docs");

    const third = await PluginProcess.start(dirs.env("session-3", "docs"));
    const exit = await third.exited;

    expect(exit.code).toBe(EXIT_FAILED);
    expect(exit.stderr).toContain('Band agent "docs" is already connected from another session');
    const status = await agentsCommand(...dirs.cliContext, "status", "session-3");
    expect(status).toContain('This session: refused. Band agent "docs" is already connected from another session');
    expect(status).toContain("No agent is free");
  });

  it("fails a session that selects an agent never saved, and says so in /band:agents", async () => {
    using dirs = savedAs(await Agents.provision("claude-code", "unsaved"));

    const exit = await PluginProcess.exitOf(dirs.env("session-1", "missing"));

    expect(exit.code).toBe(EXIT_FAILED);
    // The log carries the error as JSON.
    expect(exit.stderr).toContain(JSON.stringify('No Band agent named "missing"').slice(1, -1));
    expect(await agentsCommand(...dirs.cliContext, "status", "session-1")).toContain(
      'This session: not connected. No Band agent named "missing". Saved: main. Add it with /band:agents add <agent_id> <api_key> missing',
    );
  });
});
