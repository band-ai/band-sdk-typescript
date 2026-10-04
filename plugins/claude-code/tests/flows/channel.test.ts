/**
 * The plugin between a Band platform and Claude Code, both run for real
 * except for the network: delivered messages become channel pushes, and
 * Claude's tool calls post back to the room they came from.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, test } from "vitest";

import { COMMAND_REFUSAL } from "../../src/adapter";
import { CHANNEL_CAPABILITY, EXIT_OK } from "../../src/channel";
import { agent, AGENT_HANDLE, AGENT_ID, BandPlatform, person, type BandRoom } from "../../../../packages/sdk/tests/flows/support/bandPlatform";
import { ClaudeCodeSession } from "./support/claudeCode";

const OWNER = "owner-1";
const USER = "user-1";
const PEER_AGENT = "agent-2";
const PEOPLE = [person(OWNER), person(USER), agent(PEER_AGENT)];
const ROOM = "room-1";
const LATER_ROOM = "room-2";
const PLATFORM_DOWN = new Error("platform unavailable");
const MENTION = `@[[${AGENT_ID}]]`;
// Longer than the plugin takes to start a runtime it was not told to hold back.
const SETTLE_MS = 100;

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
    await using session = await ClaudeCodeSession.connect({ transport: band.platform.transport, restApi: band.platform.rest });
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

  it("pushes the owner's slash command", async ({ band, session }) => {
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
    await using session = new ClaudeCodeSession({ transport: band.platform.transport, restApi: band.platform.rest });

    await sleep(SETTLE_MS);
    expect(band.platform.rest.processing.entries).toEqual([]);

    await session.connect();
    expect((await session.pushOf(id)).content).toBe(`@${AGENT_HANDLE} are you there?`);
    expect(await band.room.outcome(id)).toBe("processed");
  });
});

describe("with no owner on record", () => {
  it("refuses every slash command", async () => {
    const platform = BandPlatform.host(PEOPLE, { ownerUuid: null });
    const room = await platform.room(ROOM);
    await using _session = await ClaudeCodeSession.connect({ transport: platform.transport, restApi: platform.rest });

    const id = await room.say(OWNER, `${MENTION} /compact`);

    expect(await room.outcome(id)).toBe("processed");
    expect(room.messages).toEqual([expect.objectContaining({ content: COMMAND_REFUSAL, mentions: [OWNER] })]);
  });
});

describe("Claude's Band tools", () => {
  it("posts to a room a message came from", async ({ band, session }) => {
    await session.pushOf(await band.room.say(USER, `${MENTION} ping`));

    const reply = await session.callTool("band_send_message", { room_id: ROOM, content: "pong", mentions: [USER] });

    expect(reply.isError).toBe(false);
    expect(band.room.messages).toEqual([expect.objectContaining({ content: "pong", mentions: [USER] })]);
  });

  it("refuses a room the agent was removed from", async ({ band, session }) => {
    await session.pushOf(await band.room.say(USER, `${MENTION} ping`));
    await band.room.remove();
    // Agent-level events are handled in order: once a room added afterwards serves, the removal is torn down.
    const later = await band.platform.room(LATER_ROOM);
    await session.pushOf(await later.say(USER, `${MENTION} still here`));

    const reply = await session.callTool("band_send_message", { room_id: ROOM, content: "pong", mentions: [USER] });

    expect(reply).toEqual({ isError: true, text: `No tool context found for room_id ${ROOM}` });
  });

  it("refuses a room no message came from", async ({ session }) => {
    const reply = await session.callTool("band_send_message", { room_id: "room-unseen", content: "hi", mentions: [USER] });

    expect(reply).toEqual({ isError: true, text: "No tool context found for room_id room-unseen" });
  });

  it("offers neither memory nor contact tools", async ({ session }) => {
    const names = await session.toolNames();

    expect(names).toContain("band_send_message");
    expect(names.filter((name) => /memor|contact/.test(name))).toEqual([]);
  });
});

describe("Claude Code's handshake", () => {
  it("advertises the server as a Claude Code channel", async ({ session }) => {
    expect(session.capabilities?.experimental).toEqual({ [CHANNEL_CAPABILITY]: {} });
  });
});

describe("when Claude Code exits", () => {
  it("releases the agent and exits 0", async ({ band, session }) => {
    expect(await session.leave()).toBe(EXIT_OK);
    expect(band.platform.transport.isConnected()).toBe(false);
  });

  it("exits 0 when it leaves before its handshake", async ({ band }) => {
    const session = new ClaudeCodeSession({ transport: band.platform.transport, restApi: band.platform.rest });

    expect(await session.leave()).toBe(EXIT_OK);
  });

  it("leaves the backlog it didn't push for the next session", async ({ band }) => {
    const first = band.room.postBeforeConnect(USER, `${MENTION} one`);
    const second = band.room.postBeforeConnect(USER, `${MENTION} two`);
    const held = band.room.holdProcessing(second);
    const link = { transport: band.platform.transport, restApi: band.platform.rest };
    const leaving = await ClaudeCodeSession.connect(link);
    await leaving.pushOf(first);
    await held.sending;

    expect(await leaving.leave()).toBe(EXIT_OK);
    held.release();

    await using next = await ClaudeCodeSession.connect(link);
    expect((await next.pushOf(second)).meta.message_id).toBe(second);
    expect(await band.room.outcome(second)).toBe("processed");
  });
});
