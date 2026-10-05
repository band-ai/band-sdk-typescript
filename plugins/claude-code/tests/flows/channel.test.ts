/**
 * The plugin between a Band platform and Claude Code, both run for real
 * except for the network: delivered messages become channel pushes, and
 * Claude's tool calls post back to the room they came from.
 */
import { ROOM_TOOL_NAMES } from "@band-ai/sdk/runtime";
import { describe, expect, test } from "vitest";

import { COMMAND_REFUSAL, SENDER_ROLE } from "../../src/adapter";
import { CHANNEL_CAPABILITY, EXIT_OK } from "../../src/channel";
import { FIND_ROOMS_TOOL_NAME, type FoundRoom } from "../../src/rooms";
import { agent, AGENT_HANDLE, AGENT_ID, BandPlatform, person, type BandRoom } from "../../../../packages/sdk/tests/flows/support/bandPlatform";
import { ClaudeCodeSession, type ToolReply } from "./support/claudeCode";

const OWNER = "owner-1";
const USER = "user-1";
const PEER_AGENT = "agent-2";
const PEER_HANDLE = "owner/claude2";
const PEER = { ...agent(PEER_AGENT), handle: PEER_HANDLE };
const PEOPLE = [person(OWNER), person(USER), PEER];
const ROOM = "room-1";
const LATER_ROOM = "room-2";
const PLATFORM_DOWN = new Error("platform unavailable");
const MENTION = `@[[${AGENT_ID}]]`;
const SEND_MESSAGE = "band_send_message";

interface Fixture {
  platform: BandPlatform;
  room: BandRoom;
}

const it = test.extend<{ band: Fixture; session: ClaudeCodeSession }>({
  band: async ({}, use) => {
    const platform = BandPlatform.host(PEOPLE, { ownerUuid: OWNER });
    await use({ platform, room: await platform.room(ROOM) });
  },
  session: async ({ band }, use) => {
    await using session = await ClaudeCodeSession.connect(band.platform.link);
    await use(session);
  },
});

describe("Band messages reach Claude Code", () => {
  it("pushes the owner's mention as the owner, then marks it processed", async ({ band, session }) => {
    const id = await band.room.say(OWNER, `${MENTION} run the tests`);

    expect(await session.pushOf(id)).toEqual({
      content: `@${AGENT_HANDLE} run the tests`,
      meta: { room_id: ROOM, message_id: id, sender_id: OWNER, sender_name: OWNER, sender_role: "owner", sender_type: "User" },
    });
    expect(await band.room.outcome(id)).toBe("processed");
  });

  it("leaves out the sender's name when the platform has none", async ({ band, session }) => {
    const id = await band.room.say(USER, `${MENTION} hi`, { senderName: null });

    expect((await session.pushOf(id)).meta).not.toHaveProperty("sender_name");
  });

  it("pushes other users and agents as participants", async ({ band, session }) => {
    const fromUser = await band.room.say(USER, `${MENTION} hi`);
    const fromAgent = await band.room.say(PEER_AGENT, `${MENTION} done`, { senderType: "Agent" });

    expect((await session.pushOf(fromUser)).meta).toMatchObject({ sender_id: USER, sender_role: "participant", sender_type: "User" });
    expect((await session.pushOf(fromAgent)).meta).toMatchObject({ sender_id: PEER_AGENT, sender_role: "participant", sender_type: "Agent" });
    expect(await band.room.outcome(fromAgent)).toBe("processed");
  });

  it("pushes the owner's slash command to Claude as text", async ({ band, session }) => {
    const id = await band.room.say(OWNER, `${MENTION} /compact`);

    expect((await session.pushOf(id)).content).toBe(`@${AGENT_HANDLE} /compact`);
  });

  it("refuses a participant's slash command in the room instead of pushing it", async ({ band, session }) => {
    const command = await band.room.say(USER, `${MENTION} /clear`);
    expect(await band.room.outcome(command)).toBe("processed");
    const after = await band.room.say(OWNER, `${MENTION} next`);
    await session.pushOf(after);

    expect(band.room.messages).toEqual([expect.objectContaining({ content: COMMAND_REFUSAL, mentions: [USER] })]);
    expect(session.pushes.entries.map((push) => push.meta.message_id)).toEqual([after]);
  });

  it("keeps serving when a refusal can't be posted", async ({ band, session }) => {
    band.room.holdMessage((content) => content === COMMAND_REFUSAL, { error: PLATFORM_DOWN }).release();
    const command = await band.room.say(USER, `${MENTION} /clear`);
    expect(await band.room.outcome(command)).toBe("failed");

    const after = await band.room.say(OWNER, `${MENTION} next`);
    expect((await session.pushOf(after)).meta.message_id).toBe(after);
  });

  it("pushes neither its own messages nor events", async ({ band, session }) => {
    await band.room.say(AGENT_ID, `${MENTION} echo`, { senderType: "Agent" });
    const thought = await band.room.say(USER, `${MENTION} thinking`, { messageType: "thought" });
    expect(await band.room.outcome(thought)).toBe("processed");
    const after = await band.room.say(OWNER, `${MENTION} next`);
    await session.pushOf(after);

    expect(session.pushes.entries.map((push) => push.meta.message_id)).toEqual([after]);
  });

  it("holds a message left before Claude Code connected until it has", async ({ band }) => {
    const id = band.room.postBeforeConnect(USER, `${MENTION} are you there?`);
    await using session = new ClaudeCodeSession(band.platform.link);
    const initialized = session.holdInitialized();
    const connecting = session.connect();

    await initialized.sending;
    expect(band.platform.rest.processing.entries).toEqual([]);

    initialized.release();
    await connecting;
    expect((await session.pushOf(id)).content).toBe(`@${AGENT_HANDLE} are you there?`);
    expect(await band.room.outcome(id)).toBe("processed");
  });
});

describe("with no owner on record", () => {
  it("refuses every slash command", async () => {
    const platform = BandPlatform.host(PEOPLE, { ownerUuid: null });
    const room = await platform.room(ROOM);
    await using _session = await ClaudeCodeSession.connect(platform.link);

    const id = await room.say(OWNER, `${MENTION} /compact`);

    expect(await room.outcome(id)).toBe("processed");
    expect(room.messages).toEqual([expect.objectContaining({ content: COMMAND_REFUSAL, mentions: [OWNER] })]);
  });
});

describe("Claude's Band tools", () => {
  it("posts to a room a message came from", async ({ band, session }) => {
    await session.pushOf(await band.room.say(USER, `${MENTION} ping`));

    const reply = await session.callTool(SEND_MESSAGE, { room_id: ROOM, content: "pong", mentions: [USER] });

    expect(reply.isError).toBe(false);
    expect(band.room.messages).toEqual([expect.objectContaining({ content: "pong", mentions: [USER] })]);
  });

  it("posts to a room the agent is in that no message came from", async ({ band, session }) => {
    const reply = await session.callTool(SEND_MESSAGE, { room_id: ROOM, content: "hi", mentions: [USER] });

    expect(reply.isError).toBe(false);
    expect(band.room.messages).toEqual([expect.objectContaining({ content: "hi", mentions: [USER] })]);
  });

  it("posts to a room the agent was added to mid-session", async ({ band, session }) => {
    const later = await band.platform.room(LATER_ROOM);

    expect((await session.callTool(SEND_MESSAGE, { room_id: LATER_ROOM, content: "hi", mentions: [USER] })).isError).toBe(false);
    expect(later.messages).toEqual([expect.objectContaining({ content: "hi", mentions: [USER] })]);
  });

  it("passes on Band's refusal of a room the agent was removed from", async ({ band, session }) => {
    await session.pushOf(await band.room.say(USER, `${MENTION} ping`));
    await band.room.remove();
    // Agent-level events are handled in order: once a room added afterwards serves, the removal is torn down.
    const later = await band.platform.room(LATER_ROOM);
    await session.pushOf(await later.say(USER, `${MENTION} still here`));

    expectRefusedByBand(await session.callTool(SEND_MESSAGE, { room_id: ROOM, content: "pong", mentions: [USER] }));
  });

  it("passes on Band's refusal of a room the agent was never in", async ({ session }) => {
    expectRefusedByBand(await session.callTool(SEND_MESSAGE, { room_id: "room-unseen", content: "hi", mentions: [USER] }));
  });

  it("creates a room, adds another agent and works with it there, before Band's room_added has been handled", async ({ band, session }) => {
    const created = await session.callTool("band_create_chatroom", {});
    const roomId = created.text;

    expect(created.isError).toBe(false);
    expect((await session.callTool("band_add_participant", { room_id: roomId, name: PEER_AGENT })).isError).toBe(false);
    expect((await session.callTool(SEND_MESSAGE, { room_id: roomId, content: "let's start", mentions: [PEER_AGENT] })).isError).toBe(false);
    expect(band.platform.rest.added.entries).toEqual([{ roomId, participantId: PEER_AGENT }]);
    expect(band.platform.created(roomId).messages).toEqual([expect.objectContaining({ content: "let's start", mentions: [PEER_AGENT] })]);
  });

  it("takes a room_id on exactly the tools that act on a room", async ({ session }) => {
    const tools = await session.tools();
    const takesRoom = tools.filter((tool) => tool.inputSchema.required?.includes("room_id")).map((tool) => tool.name);

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["band_create_chatroom", "band_no_reply", FIND_ROOMS_TOOL_NAME]));
    expect(takesRoom.sort()).toEqual(tools.map((tool) => tool.name).filter((name) => ROOM_TOOL_NAMES.has(name)).sort());
    expect(tools.filter((tool) => "room_id" in (tool.inputSchema.properties ?? {})).map((tool) => tool.name).sort()).toEqual(takesRoom.sort());
  });

  it("offers neither memory nor contact tools", async ({ session }) => {
    const names = await session.toolNames();

    expect(names).toContain("band_send_message");
    expect(names.filter((name) => /memor|contact/.test(name))).toEqual([]);
  });
});

describe("band_find_rooms", () => {
  it("puts the smaller of two rooms with the agent first", async ({ band, session }) => {
    await band.platform.room(LATER_ROOM, [PEER]);

    expect((await findRooms(session, [PEER_AGENT])).map((room) => room.room_id)).toEqual([LATER_ROOM, ROOM]);
  });

  it("finds a room it created by the added agent's handle, with or without its @", async ({ session }) => {
    const roomId = (await session.callTool("band_create_chatroom", {})).text;
    await session.callTool("band_add_participant", { room_id: roomId, name: PEER_AGENT });

    for (const handle of [PEER_HANDLE, `@${PEER_HANDLE.toUpperCase()}`]) {
      expect(await findRooms(session, [handle]), handle).toEqual([
        { room_id: roomId, title: expect.any(String), participants: [{ name: PEER_AGENT, handle: PEER_HANDLE, type: "Agent" }] },
        expect.objectContaining({ room_id: ROOM }),
      ]);
    }
  });

  it("finds nothing for someone in none of the agent's rooms", async ({ session }) => {
    expect(await findRooms(session, ["nobody"])).toEqual([]);
  });

  it("lists every room the agent is in when given nobody", async ({ band, session }) => {
    await band.platform.room(LATER_ROOM, [PEER]);

    expect((await findRooms(session)).map((room) => room.room_id).sort()).toEqual([ROOM, LATER_ROOM]);
  });
});

describe("Claude Code's handshake", () => {
  it("advertises the server as a Claude Code channel, with the rules for its messages", async ({ session }) => {
    expect(session.capabilities?.experimental).toEqual({ [CHANNEL_CAPABILITY]: {} });
    expect(session.instructions).toContain('<channel source="plugin:band:band" room_id="…" message_id="…" sender_id="…"');
    expect(session.instructions).toContain(`sender_role="${SENDER_ROLE.owner}" is the agent's owner; sender_role="${SENDER_ROLE.participant}" is any other Band user or agent`);
  });

  it("tells Claude which Band agent it is", async ({ session }) => {
    expect(session.instructions?.split("\n")[0]).toBe(
      `You are connected to Band, a chat platform, as @${AGENT_HANDLE} (agent "main" in /band:agents).`,
    );
  });

  it("names the agent by its Band name when it has no handle", async () => {
    const platform = BandPlatform.host(PEOPLE, { ownerUuid: OWNER, handle: null });
    await using session = await ClaudeCodeSession.connect(platform.link, { agentName: "docs" });

    expect(session.instructions?.split("\n")[0]).toBe('You are connected to Band, a chat platform, as Agent (agent "docs" in /band:agents).');
  });
});

describe("when Claude Code exits", () => {
  it("releases the agent and exits 0", async ({ band, session }) => {
    expect(await session.leave()).toBe(EXIT_OK);
    expect(band.platform.transport.isConnected()).toBe(false);
  });

  it("exits 0 when it leaves before its handshake", async ({ band }) => {
    const session = new ClaudeCodeSession(band.platform.link);

    expect(await session.leave()).toBe(EXIT_OK);
  });

  it("leaves a backlog message for the next session when its read returns after exit", async ({ band }) => {
    const waiting = band.room.postBeforeConnect(USER, `${MENTION} waiting`);
    const held = band.platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM);
    const leaving = await ClaudeCodeSession.connect(band.platform.link);
    await held.sending;

    expect(await leaving.leave()).toBe(EXIT_OK);
    held.release();

    await using next = await ClaudeCodeSession.connect(band.platform.link);
    expect((await next.pushOf(waiting)).meta.message_id).toBe(waiting);
    expect(await band.room.outcome(waiting)).toBe("processed");
    expect(band.platform.rest.processing.entries).toEqual([waiting]);
  });

  it("stops at the turn in flight and leaves the rest of the backlog for the next session", async ({ band }) => {
    const first = band.room.postBeforeConnect(USER, `${MENTION} one`);
    const inFlight = band.room.postBeforeConnect(USER, `${MENTION} two`);
    const waiting = band.room.postBeforeConnect(USER, `${MENTION} three`);
    const held = band.room.holdProcessing(inFlight);
    const leaving = await ClaudeCodeSession.connect(band.platform.link);
    await leaving.pushOf(first);
    await held.sending;

    expect(await leaving.leave()).toBe(EXIT_OK);
    held.release();
    expect(await band.room.outcome(inFlight)).toBe("failed");

    await using next = await ClaudeCodeSession.connect(band.platform.link);
    expect((await next.pushOf(waiting)).meta.message_id).toBe(waiting);
    expect(await band.room.outcome(waiting)).toBe("processed");
  });

  it("exits when it leaves while a room it was removed from still has a turn in flight", async ({ band }) => {
    const session = await ClaudeCodeSession.connect(band.platform.link);
    const id = await band.room.say(USER, `${MENTION} hi`);
    const held = band.room.holdProcessing(id);
    await held.sending;
    // The removal unsubscribes, then waits on the held turn to tear the room down.
    await Promise.all([band.room.left(), band.room.remove()]);
    await session.departed();

    held.release();

    expect(await session.exited).toBe(EXIT_OK);
    expect(band.platform.transport.isConnected()).toBe(false);
  });
});

async function findRooms(session: ClaudeCodeSession, participants?: string[]): Promise<FoundRoom[]> {
  const reply = await session.callTool(FIND_ROOMS_TOOL_NAME, participants ? { participants } : {});
  expect(reply.isError).toBe(false);
  return JSON.parse(reply.text) as FoundRoom[];
}

/** How a tool call reports Band's 404 for a room the agent isn't in. */
function expectRefusedByBand(reply: ToolReply): void {
  expect(reply.isError).toBe(true);
  expect(reply.text.startsWith(`Error executing ${SEND_MESSAGE}: NotFoundError`), reply.text).toBe(true);
  expect(reply.text).toContain("Status code: 404");
}
