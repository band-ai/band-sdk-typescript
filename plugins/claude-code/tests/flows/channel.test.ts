/**
 * The plugin between a Band platform and Claude Code, both run for real
 * except for the network: delivered messages become channel pushes, and
 * Claude's tool calls post back to the room they came from.
 */
import { describe, expect, test } from "vitest";

import { COMMAND_REFUSAL, SENDER_ROLE } from "../../src/adapter";
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
  it("advertises the server as a Claude Code channel, with the rules for its messages", async ({ session }) => {
    expect(session.capabilities?.experimental).toEqual({ [CHANNEL_CAPABILITY]: {} });
    const rules = session.instructions?.split("\n\n").slice(1).join("\n\n");
    expect(rules).toContain('<channel source="plugin:band:band" room_id="…" message_id="…" sender_id="…"');
    expect(rules).toContain(`sender_role="${SENDER_ROLE.owner}" is the agent's owner; sender_role="${SENDER_ROLE.participant}" is any other Band user or agent`);
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
