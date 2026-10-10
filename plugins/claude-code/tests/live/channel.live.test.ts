/**
 * The built plugin against the live platform, under a parent whose command line
 * carries Band's channel flag, with an MCP client in Claude Code's place and no
 * LLM: what Band delivers is pushed, what the client calls posts back, each
 * session connects as the agent the user picks, and the last pick of an agent wins.
 */
import { describe, expect, it, onTestFinished } from "vitest";

import { agentResourceUri } from "../../src/agentResources";
import { CHANNEL_CAPABILITY, EXIT_OK } from "../../src/channel";
import { AGENT_SELECT_ENV, writeSavedAgents } from "../../src/config";
import { CHANNEL_OFF_INSTRUCTIONS } from "../../src/prompt";
import type { FoundRoom } from "../../src/rooms";
import { agentLabel } from "../../src/names";
import { SESSION_TEXT } from "../../src/sessions";
import { BOARD_TOOL } from "../../src/board";
import { CONNECT_TOOL, TOOL } from "../../src/tools";
import { deleteRoomsBulk } from "../../../../packages/sdk/tests/integration/support/liveHarness";
import { Agents, type AgentIdentity } from "../../../../packages/sdk/tests/baseline/toolkit/agents";
import { liveRun, warnTeardown } from "../../../../packages/sdk/tests/baseline/toolkit/liveRun";
import { DELIVERY_STATUS, observeAgent } from "../../../../packages/sdk/tests/baseline/toolkit/observeDelivery";
import { history, MESSAGE_TYPE, observeRoom, REPLY_WAIT } from "../../../../packages/sdk/tests/baseline/toolkit/observeMessages";
import { ACTIVITY_EVENT, Rooms, type ActivityFrame, type Room } from "../../../../packages/sdk/tests/baseline/toolkit/rooms";
import { callTool, CLOSED, pick } from "../support/channelClient";
import { ClaudeCodeDirs } from "../support/claudeCodeDirs";
import { agentsCommand, PluginProcess } from "./support/pluginProcess";

const MAIN = "main";

async function agentInRoom(label: string): Promise<{ identity: AgentIdentity; room: Room }> {
  const identity = await Agents.provision("claude-code", label);
  const room = await Rooms.create();
  await Rooms.addParticipant(room, identity);
  return { identity, room };
}

/** Directories in which `identity` is the one agent saved, as `/band:agents add` leaves them. */
function savedAs(identity: AgentIdentity, name = MAIN): ClaudeCodeDirs {
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

/** The plugin in session `sessionId`, connected without a question as the agent `BAND_AGENT` names. */
async function connectedAs(dirs: ClaudeCodeDirs, sessionId: string, agent = MAIN): Promise<PluginProcess> {
  const plugin = await PluginProcess.start({ ...dirs.env(sessionId), [AGENT_SELECT_ENV]: agent });
  await plugin.connected();
  return plugin;
}

/** What `/band:agents status` says for session `sessionId`, without the line end the command prints. */
async function statusOf(dirs: ClaudeCodeDirs, sessionId: string): Promise<string> {
  return (await agentsCommand(...dirs.cliContext, "status", sessionId)).trimEnd();
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
    const plugin = await connectedAs(dirs, "session-1");

    expect(plugin.client.getServerCapabilities()?.experimental).toEqual({ [CHANNEL_CAPABILITY]: {} });
    const { tools } = await plugin.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...Object.values(TOOL), ...Object.keys(BOARD_TOOL)].sort());

    const sent = await Rooms.sendMention(room, identity, "ping");
    const push = await plugin.pushOf(sent.id);
    await nextActivity(room, identity, ACTIVITY_EVENT.started, room.activity.entries.length);
    expect(push.meta).toMatchObject({ room_id: room.id, message_id: sent.id, sender_role: "owner", sender_type: "User" });
    expect((await observeAgent(identity, room).untilProcessed(sent)).status).toBe(DELIVERY_STATUS.processed);

    // Taken before the call: the stop can land before the tool's answer does.
    const beforeReply = room.activity.entries.length;
    await callOk(plugin, TOOL.reply, { message_id: push.meta.message_id, content: "pong" });
    // The platform stores the reply behind its mention token.
    const posted = await observeRoom(room).untilReplyMatching(identity, (message) => message.content.endsWith(" pong"));
    expect(posted.kind).toBe(REPLY_WAIT.reply);
    await nextActivity(room, identity, ACTIVITY_EVENT.stopped, beforeReply);

    expect((await plugin.leave()).code).toBe(EXIT_OK);
    await using next = await connectedAs(dirs, "session-2");
    await expectServing(next, room, identity, "still there?");
  });

  it("opens a room with another agent and the owner, reuses it, posts there, and posts to a room no message came from", async () => {
    const { identity, room } = await agentInRoom("rooms");
    const peer = await Agents.provision("claude-code", "rooms-peer");
    using dirs = savedAs(identity);
    await using plugin = await connectedAs(dirs, "session-1");
    const peerHandle = await peer.handle();
    const peerMetadata = await peer.rest.getAgentMe();
    const uri = agentResourceUri(peerHandle);
    const description = peerMetadata.description?.trim() ? peerMetadata.description : null;
    const rows = await plugin.resourcesWhen((resources) => resources.some((resource) => resource.uri === uri));
    expect(rows.find((resource) => resource.uri === uri)).toMatchObject({
      name: `@${peerHandle}`, description: description ?? peerMetadata.name, mimeType: "text/plain",
    });
    const { contents } = await plugin.client.readResource({ uri });
    expect(JSON.parse((contents[0] as { text: string }).text)).toEqual({ handle: peerHandle, name: peerMetadata.name, description });
    expect((await plugin.client.listResourceTemplates()).resourceTemplates).toEqual([]);
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
    const plugin = await connectedAs(dirs, "session-1");
    const sent = await Rooms.sendMention(room, identity, "working?");
    await plugin.pushOf(sent.id);
    // From the push on: the plugin reports working only once it has pushed, while Band's own flash for the message lands earlier.
    await nextActivity(room, identity, ACTIVITY_EVENT.started, room.activity.entries.length);

    const beforeStop = room.activity.entries.length;
    expect((await plugin.interrupt()).code).toBe(EXIT_OK);

    await nextActivity(room, identity, ACTIVITY_EVENT.stopped, beforeStop);
  });

  it("connects as the agent the user picks, and a second session's pick of it takes it over", async () => {
    const { identity, room } = await agentInRoom("takeover");
    using dirs = savedAs(identity);
    await using first = await PluginProcess.start(dirs.env("session-1"), { answers: [pick(MAIN)] });
    await first.connected();
    await expectServing(first, room, identity, "first");

    await using second = await PluginProcess.start(dirs.env("session-2"), { answers: [pick(MAIN)] });
    await second.connected();

    expect(await first.toolNamesWhen((names) => names.includes(CONNECT_TOOL))).toEqual([CONNECT_TOOL]);
    expect(await statusOf(dirs, "session-1")).toBe(`off: ${SESSION_TEXT.takenOver(`@${await identity.handle()}`)}`);
    await expectServing(second, room, identity, "second");
  });

  it("connects the next pick at once after the session holding the agent is killed", async () => {
    const { identity, room } = await agentInRoom("killed");
    using dirs = savedAs(identity);
    const killed = await connectedAs(dirs, "session-1");
    await expectServing(killed, room, identity, "before the crash");

    process.kill(dirs.session("session-1")!.serverPid, "SIGKILL");
    await killed.exited;

    await using next = await PluginProcess.start(dirs.env("session-2"), { answers: [pick(MAIN)] });
    await next.connected();
    await expectServing(next, room, identity, "after the crash");
  });

  it("stays off when the question is closed, and connect asks again", async () => {
    const { identity, room } = await agentInRoom("cancel");
    using dirs = savedAs(identity);
    await using plugin = await PluginProcess.start(dirs.env("session-1"));
    await plugin.question();
    // Called while the start question is open, connect waits on that same question.
    const closing = callTool(plugin.client, CONNECT_TOOL, {});
    plugin.answer(CLOSED);

    expect((await closing).text).toBe(SESSION_TEXT.notPicked);
    expect(await statusOf(dirs, "session-1")).toBe(`off: ${SESSION_TEXT.notPicked}`);

    plugin.answer(pick(MAIN));
    expect(await callOk(plugin, CONNECT_TOOL, {})).toBe(SESSION_TEXT.connected(agentLabel(MAIN, await identity.handle())));
    await expectServing(plugin, room, identity, "picked");
  });

  it("lists nothing and stays off without Band's channel, telling Claude how to restart", async () => {
    using dirs = savedAs(await Agents.provision("claude-code", "no-flag"));
    const plugin = await PluginProcess.start({ ...dirs.env("session-1"), [AGENT_SELECT_ENV]: MAIN }, { channel: false });

    expect((await plugin.client.listTools()).tools).toEqual([]);
    expect(plugin.client.getInstructions()).toBe(CHANNEL_OFF_INSTRUCTIONS);
    expect(await statusOf(dirs, "session-1")).toBe(`off: ${SESSION_TEXT.noChannel}`);
    expect((await plugin.leave()).code).toBe(EXIT_OK);
  });
});
