/**
 * Claude's Band toolkit over the plugin's real stdio, on a Band platform:
 * replies by message id, posts that always mention someone, rooms opened or
 * reused by who is in them, and Band's working indicator around each push.
 */
import { describe, expect } from "vitest";

import { TOOL, ALWAYS_LOAD_META } from "../../src/tools";
import { AGENT_HANDLE, AGENT_ID, BandPlatform } from "../../../../packages/sdk/tests/flows/support/bandPlatform";
import type { ToolReply } from "../support/channelClient";
import { it, OWNER, PEER, PEER_AGENT, PEER_HANDLE, PEOPLE, QA_MOBILE, QA_WEB, ROOM, USER } from "./support/band";
import { ClaudeCodeSession, linkTo } from "./support/claudeCode";

const MENTION = `@[[${AGENT_ID}]]`;
const PEER_ROOM = "room-2";
const OTHER_PEER_ROOM = "room-3";
const ALWAYS_LOAD = Object.keys(ALWAYS_LOAD_META)[0];

describe("the tool list", () => {
  it("is exactly the eight Band tools, and only reply and send always load", async ({ session }) => {
    const tools = await session.tools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.values(TOOL).sort());
    expect(tools.filter((tool) => tool._meta?.[ALWAYS_LOAD] === true).map((tool) => tool.name).sort()).toEqual([TOOL.reply, TOOL.send]);
  });
});

describe("reply", () => {
  it("posts in the message's room, mentioning its sender once even when asked to mention them again", async ({ band, session }) => {
    const id = await band.room.say(USER, `${MENTION} ping`);
    await session.pushOf(id);

    const reply = await session.callTool(TOOL.reply, { message_id: id, content: "pong", mentions: [USER] });

    expect(reply).toEqual({ isError: false, text: `Posted as @${AGENT_HANDLE}, mentioning @${USER}.` });
    expect(band.room.messages).toEqual([expect.objectContaining({ content: "pong", mentions: [USER] })]);
  });

  it("also mentions another participant it is asked to, once each", async ({ band, session }) => {
    const id = await band.room.say(USER, `${MENTION} who reviews this?`);
    await session.pushOf(id);

    const reply = await session.callTool(TOOL.reply, { message_id: id, content: "over to them", mentions: [PEER_HANDLE, USER] });

    expect(reply).toEqual({ isError: false, text: `Posted as @${AGENT_HANDLE}, mentioning @${USER}, @${PEER_HANDLE}.` });
    expect(band.room.messages).toEqual([expect.objectContaining({ content: "over to them", mentions: [USER, PEER_AGENT] })]);
  });

  it("posts nothing when another mention matches nobody in the room", async ({ band, session }) => {
    const id = await band.room.say(USER, `${MENTION} ping`);
    await session.pushOf(id);

    const reply = await session.callTool(TOOL.reply, { message_id: id, content: "pong", mentions: ["nobody"] });

    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('Nobody matches "nobody"');
    expect(band.platform.rest.posted.entries).toEqual([]);
  });

  it("names the agent by its Band name when it has no handle", async () => {
    const platform = BandPlatform.host(PEOPLE, { ownerUuid: OWNER, handle: null });
    const room = await platform.room(ROOM);
    await using session = await ClaudeCodeSession.connect(linkTo(platform));
    const id = await room.say(USER, `${MENTION} ping`);
    await session.pushOf(id);

    expect((await session.tools()).find((tool) => tool.name === TOOL.reply)?.description).toMatch(/^Posts on Band as Agent\./);
    expect(await session.callTool(TOOL.reply, { message_id: id, content: "pong" })).toEqual({ isError: false, text: `Posted as Agent, mentioning @${USER}.` });
  });

  it("posts nothing for a message it doesn't know, and points to fetch_messages", async ({ band, session }) => {
    const reply = await session.callTool(TOOL.reply, { message_id: "msg-unknown", content: "pong" });

    expect(reply.isError).toBe(true);
    expect(reply.text).toContain(`${TOOL.fetchMessages}(room_id)`);
    expect(band.platform.rest.posted.entries).toEqual([]);
  });

  it("posts nothing once the sender has left, and lists who remains", async ({ band, session }) => {
    const id = await band.room.say(USER, `${MENTION} ping`);
    await session.pushOf(id);
    await band.platform.rest.removeChatParticipant(ROOM, USER);

    const reply = await session.callTool(TOOL.reply, { message_id: id, content: "pong" });

    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("The sender has left the room");
    expect(reply.text).toContain(`@${OWNER}`);
    expect(reply.text).not.toContain(`@${USER}`);
    expect(band.platform.rest.posted.entries).toEqual([]);
  });
});

describe("send", () => {
  it("posts nothing when told to mention the agent itself, and lists the room's participants", async ({ band, session }) => {
    const reply = await session.callTool(TOOL.send, { room_id: ROOM, content: "hi", mentions: [`@${AGENT_HANDLE}`] });

    expect(reply.isError).toBe(true);
    expect(reply.text).toContain(`@${USER}`);
    expect(reply.text).toContain(`@${PEER_HANDLE} — ${PEER.description}`);
    expect(band.platform.rest.posted.entries).toEqual([]);
  });

  it("posts nothing with nobody to mention", async ({ band, session }) => {
    const reply = await session.callTool(TOOL.send, { room_id: ROOM, content: "hi", mentions: [] });

    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("Say whom to mention");
    expect(band.platform.rest.posted.entries).toEqual([]);
  });
});

describe("open_room", () => {
  it("reuses the most recently active of two rooms with exactly those participants", async ({ band, session }) => {
    await band.platform.room(PEER_ROOM, [PEER]);
    const active = await band.platform.room(OTHER_PEER_ROOM, [PEER]);
    await session.pushOf(await active.say(PEER_AGENT, `${MENTION} still around?`, { senderType: "Agent" }));

    const opened = await session.callTool(TOOL.openRoom, { participants: [PEER_HANDLE] });

    expect(opened).toEqual({ isError: false, text: `Reused '${active.id}' (room_id ${active.id}).` });
    expect(await roomCount(band)).toBe(3);
  });

  it("creates a room when every room has someone more", async ({ band, session }) => {
    await band.platform.room(PEER_ROOM, [PEER]);

    const opened = await session.callTool(TOOL.openRoom, { participants: [PEER_HANDLE, USER], title: "Release" });

    expect(opened.text).toMatch(/^Created 'Release' \(room_id created-.+\)\.\n@owner\/claude2: invited\n@user-1: invited$/);
    expect(await roomCount(band)).toBe(3);
  });

  it("creates a room with new: true even when one with them exists", async ({ band, session }) => {
    await band.platform.room(PEER_ROOM, [PEER]);

    const opened = await session.callTool(TOOL.openRoom, { participants: [PEER_HANDLE], new: true });

    expect(opened.text).toMatch(/^Created 'untitled; Band names it after the first message'/);
    expect(await roomCount(band)).toBe(3);
  });

  it("creates one room for two calls at once with the same participants", async ({ band, session }) => {
    const [first, second] = await Promise.all([
      session.callTool(TOOL.openRoom, { participants: [PEER_HANDLE] }),
      session.callTool(TOOL.openRoom, { participants: [`@${PEER_HANDLE.toUpperCase()}`] }),
    ]);

    expect(second).toEqual(first);
    expect(band.platform.rest.added.entries).toEqual([{ roomId: roomIdIn(first), participantId: PEER_AGENT }]);
    expect(await roomCount(band)).toBe(2);
  });

  it("reaches the one agent a description matches, and names its handle", async ({ band, session }) => {
    const opened = await session.callTool(TOOL.openRoom, { participants: ["web qa"] });

    expect(opened.text).toContain(`@${QA_WEB.handle}: invited`);
    expect(band.platform.rest.added.entries).toEqual([{ roomId: roomIdIn(opened), participantId: QA_WEB.id }]);
  });

  it("creates nothing for a name two agents match, and lists both to pick from", async ({ band, session }) => {
    const opened = await session.callTool(TOOL.openRoom, { participants: ["qa"] });

    expect(opened.isError).toBe(true);
    expect(opened.text).toContain("AskUserQuestion");
    expect(opened.text).toContain(`@${QA_WEB.handle} — ${QA_WEB.description}`);
    expect(opened.text).toContain(`@${QA_MOBILE.handle} — ${QA_MOBILE.description}`);
    expect(await roomCount(band)).toBe(1);
  });

  it("creates nothing without participants, or for a name nobody reachable matches, and lists who is", async ({ band, session }) => {
    expect(await session.callTool(TOOL.openRoom, { participants: [] })).toEqual({ isError: true, text: "Name at least one participant." });

    const opened = await session.callTool(TOOL.openRoom, { participants: [PEER_HANDLE, "docs"] });

    expect(opened.isError).toBe(true);
    expect(opened.text).toContain('Nobody matches "docs"');
    expect(opened.text).toContain(`@${QA_WEB.handle} — ${QA_WEB.description}`);
    expect(await roomCount(band)).toBe(1);
  });

  it("invites whoever it can when Band refuses some", async ({ band, session }) => {
    band.platform.rest.unreachable.add(PEER_AGENT);

    const opened = await session.callTool(TOOL.openRoom, { participants: [PEER_HANDLE, USER] });

    expect(opened.text.split("\n").slice(1)).toEqual([
      `@${PEER_HANDLE}: not invited: not reachable, usually no approved contact: approve it on Band`,
      `@${USER}: invited`,
    ]);
    expect(band.platform.rest.added.entries).toEqual([{ roomId: roomIdIn(opened), participantId: USER }]);
  });

  it("reports an invite Band refuses, and opens no second room", async ({ band, session }) => {
    band.platform.rest.unreachable.add(PEER_AGENT);

    const opened = await session.callTool(TOOL.openRoom, { participants: [PEER_HANDLE] });

    expect(opened.text).toContain(`@${PEER_HANDLE}: not invited: not reachable, usually no approved contact: approve it on Band`);
    expect(opened.text).toContain(`Nobody was invited: retry with ${TOOL.invite}(room_id)`);
    expect(await roomCount(band)).toBe(2);
  });
});

describe("rename_room", () => {
  it("renames a room the agent opened, and Band keeps the new title", async ({ session }) => {
    const roomId = roomIdIn(await session.callTool(TOOL.openRoom, { participants: [PEER_HANDLE] }));

    expect(await session.callTool(TOOL.renameRoom, { room_id: roomId, title: "Release review" })).toEqual({ isError: false, text: "Renamed to 'Release review'." });
    expect(JSON.parse((await session.callTool(TOOL.findRooms, { participants: [PEER_HANDLE] })).text)).toContainEqual(
      expect.objectContaining({ room_id: roomId, title: "Release review" }),
    );
  });

  it("says only the owner can rename a room the agent was added to, and leaves its title", async ({ session }) => {
    const renamed = await session.callTool(TOOL.renameRoom, { room_id: ROOM, title: "Mine now" });

    expect(renamed).toEqual({ isError: true, text: "Only the room's owner can rename it." });
    expect(JSON.parse((await session.callTool(TOOL.findRooms, {})).text)).toEqual([expect.objectContaining({ room_id: ROOM, title: ROOM })]);
  });

  it("passes on Band's refusal of a room the agent isn't in", async ({ session }) => {
    expect(await session.callTool(TOOL.renameRoom, { room_id: "room-unseen", title: "Hello" })).toEqual({
      isError: true,
      text: "Band refused it (404): Resource not found",
    });
  });
});

describe("invite", () => {
  it("invites nobody and says so when given nobody", async ({ band, session }) => {
    expect(await session.callTool(TOOL.invite, { room_id: ROOM, participants: [] })).toEqual({ isError: true, text: "Name at least one participant." });
    expect(band.platform.rest.added.entries).toEqual([]);
  });

  it("reports each participant as added, already in room, or failed", async ({ band, session }) => {
    const room = await band.platform.room(PEER_ROOM, [USER].map((id) => ({ id, name: id, type: "User", handle: id })));
    band.platform.rest.unreachable.add(QA_MOBILE.id);

    const invited = await session.callTool(TOOL.invite, { room_id: room.id, participants: [PEER_HANDLE, USER, "mobile"] });

    expect(invited).toEqual({
      isError: false,
      text: [
        `@${PEER_HANDLE}: added`,
        `@${USER}: already in room`,
        `@${QA_MOBILE.handle}: failed: not reachable, usually no approved contact: approve it on Band`,
      ].join("\n"),
    });
  });
});

describe("find_agents", () => {
  it("lists only agents, marking who is in the room", async ({ band, session }) => {
    await band.platform.room(PEER_ROOM, [PEER]);

    const found = await session.callTool(TOOL.findAgents, { room_id: PEER_ROOM });

    expect(found.text.split("\n")).toEqual([
      `@${PEER_HANDLE} — ${PEER.name} — ${PEER.description} (in room)`,
      `@${QA_WEB.handle} — ${QA_WEB.name} — ${QA_WEB.description}`,
      `@${QA_MOBILE.handle} — ${QA_MOBILE.name} — ${QA_MOBILE.description}`,
    ]);
  });

  it("keeps only the agents with every word of the query", async ({ session }) => {
    expect((await session.callTool(TOOL.findAgents, { query: "qa" })).text.split("\n")).toHaveLength(2);
    expect((await session.callTool(TOOL.findAgents, { query: "docs" })).text).toBe('No reachable agent matches "docs".');
    expect((await session.callTool(TOOL.findAgents, { query: "mobile qa" })).text).toBe(
      `@${QA_MOBILE.handle} — ${QA_MOBILE.name} — ${QA_MOBILE.description}`,
    );
  });
});

describe("fetch_messages", () => {
  it("lists the newest 20 of 25 messages oldest first, and reply answers one of them in a later session", async ({ band, session }) => {
    for (let n = 1; n <= 25; n += 1) {
      await session.pushOf(await band.room.say(USER, `${MENTION} message ${n}`));
    }
    await session.leave();
    await using next = await ClaudeCodeSession.connect(linkTo(band.platform));

    const fetched = await next.callTool(TOOL.fetchMessages, { room_id: ROOM, limit: 20 });

    const [header, ...lines] = fetched.text.split("\n");
    expect(header).toBe(`'${ROOM}' — @${OWNER}, @${USER}, @${PEER_HANDLE}, @${QA_WEB.handle}, @${QA_MOBILE.handle}`);
    expect(lines).toHaveLength(20);
    expect(lines[0]).toMatch(new RegExp(`^\\[.+\\] @${USER}: @${AGENT_HANDLE} message 6 \\(id: msg-.+\\)$`));
    expect(lines[19]).toContain(`@${AGENT_HANDLE} message 25 `);

    const id = /\(id: (.+)\)$/.exec(lines[19])![1];
    expect((await next.callTool(TOOL.reply, { message_id: id, content: "caught up" })).isError).toBe(false);
    expect(band.room.messages).toEqual([expect.objectContaining({ content: "caught up", mentions: [USER] })]);
  });

  it("shows a sender who has left by name, and lists 20 by default", async ({ band, session }) => {
    for (let n = 1; n <= 21; n += 1) {
      await session.pushOf(await band.room.say(USER, `${MENTION} message ${n}`));
    }
    await band.platform.rest.removeChatParticipant(ROOM, USER);

    const [header, ...lines] = (await session.callTool(TOOL.fetchMessages, { room_id: ROOM })).text.split("\n");

    expect(header).not.toContain(`@${USER}`);
    expect(lines).toHaveLength(20);
    expect(lines[0]).toMatch(new RegExp(`^\\[.+\\] ${USER}: @${AGENT_HANDLE} message 2 `));
  });

  it("refuses a limit outside 1 to 100", async ({ session }) => {
    const fetched = await session.callTool(TOOL.fetchMessages, { room_id: ROOM, limit: 101 });

    expect(fetched).toEqual({ isError: true, text: "limit must be a whole number from 1 to 100." });
  });
});

describe("Band's working indicator", () => {
  it("shows the agent working once a message is pushed, and clears it once Claude replies", async ({ band, session }) => {
    const { workingReports } = band.platform.rest;
    const id = await band.room.say(USER, `${MENTION} ping`);
    await session.pushOf(id);
    await workingReports.next((report) => report.roomId === ROOM && report.working);

    const afterPush = workingReports.entries.length;
    await session.callTool(TOOL.reply, { message_id: id, content: "pong" });

    expect(await workingReports.next((report) => report.roomId === ROOM, afterPush)).toEqual({ roomId: ROOM, working: false });
  });

  it("clears every room still working when Claude Code leaves", async ({ band, session }) => {
    const { workingReports } = band.platform.rest;
    const peerRoom = await band.platform.room(PEER_ROOM, [PEER]);
    await session.pushOf(await band.room.say(USER, `${MENTION} one`));
    await session.pushOf(await peerRoom.say(PEER_AGENT, `${MENTION} two`, { senderType: "Agent" }));
    await workingReports.next((report) => report.roomId === ROOM && report.working);
    await session.callTool(TOOL.send, { room_id: PEER_ROOM, content: "done", mentions: [PEER_HANDLE] });
    await workingReports.next((report) => report.roomId === PEER_ROOM && !report.working);
    const beforeLeaving = workingReports.entries.length;

    await session.leave();

    expect(workingReports.entries.slice(beforeLeaving)).toEqual([{ roomId: ROOM, working: false }]);
  });

  it("still pushes and replies while Band refuses every working report", async ({ band, session }) => {
    band.platform.rest.refuseActivity = true;
    const id = await band.room.say(USER, `${MENTION} ping`);
    await session.pushOf(id);

    expect((await session.callTool(TOOL.reply, { message_id: id, content: "pong" })).isError).toBe(false);
    expect(band.room.messages).toEqual([expect.objectContaining({ content: "pong", mentions: [USER] })]);
    await band.platform.rest.refusedReports.next((report) => !report.working);
  });
});

/** How many rooms the agent is in on the platform. */
async function roomCount(band: { platform: { rest: { listChats(): Promise<{ data: unknown[] }> } } }): Promise<number> {
  return (await band.platform.rest.listChats()).data.length;
}

/** The room `open_room` reported. */
function roomIdIn(reply: ToolReply): string {
  const roomId = /\(room_id ([^)]+)\)/.exec(reply.text)?.[1];
  expect(roomId, reply.text).toBeDefined();
  return roomId!;
}
