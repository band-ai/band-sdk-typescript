/** What a session's Band server reports for `/band:agents`, through a real handshake. */
import { describe, expect, it } from "vitest";

import { EXIT_OK } from "../../src/channel";
import { SESSION_TEXT } from "../../src/sessions";
import { CONNECT_TOOL } from "../../src/tools";
import { AGENT_HANDLE, AGENT_ID, BandPlatform, person } from "../../../../packages/sdk/tests/flows/support/bandPlatform";
import { pick } from "../support/channelClient";
import { AGENT_NAME, ClaudeCodeSession, linkTo, SESSION_ID } from "./support/claudeCode";

const USER = "user-1";
const ROOM = "room-1";
const MESSAGE = `@[[${AGENT_ID}]] hello`;

describe("a session's status", () => {
  it("is off until Claude Code completes its handshake, then connected, and gone once Claude Code exits", async () => {
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room(ROOM);
    await using session = new ClaudeCodeSession(linkTo(platform));
    const initialized = session.holdInitialized();
    const connecting = session.connect();

    await initialized.sending;
    expect(session.dirs.session(SESSION_ID)).toMatchObject({ projectDir: session.dirs.projectDir, state: "off", sentence: SESSION_TEXT.notPicked });

    initialized.release();
    await connecting;
    await session.pushOf(await room.say(USER, MESSAGE));
    expect(session.dirs.session(SESSION_ID)).toMatchObject({
      agent: AGENT_NAME,
      agentId: AGENT_ID,
      handle: AGENT_HANDLE,
      state: "connected",
      sentence: SESSION_TEXT.connected(`${AGENT_NAME} (@${AGENT_HANDLE})`),
    });

    expect(await session.leave()).toBe(EXIT_OK);
    expect(session.dirs.session(SESSION_ID)).toBeUndefined();
  });

  it("is off, with why, when the platform can't say who the agent is", async () => {
    const platform = BandPlatform.host([person(USER)]);
    platform.rest.agentMeHolds.hold(() => true, { error: new Error("Band is unavailable") }).release();
    await using session = await ClaudeCodeSession.connect(linkTo(platform), { agent: null });
    const failed = SESSION_TEXT.connectFailed(AGENT_NAME, "Band is unavailable");

    await session.question();
    const connecting = session.callTool(CONNECT_TOOL, {});
    session.answer(pick(AGENT_NAME));

    expect((await connecting).text).toBe(failed);
    expect(await session.status()).toBe(`off: ${failed}`);
  });
});
