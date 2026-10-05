/**
 * What a session's Band server reports for `/band:agents`, through a real
 * handshake and, for a refusal, the real Phoenix wire.
 */
import { describe, expect, it } from "vitest";

import { EXIT_FAILED, EXIT_OK } from "../../src/channel";
import { DEFAULT_AGENT_NAME } from "../../src/config";
import { AGENT_HANDLE, AGENT_ID, BandPlatform, person } from "../../../../packages/sdk/tests/flows/support/bandPlatform";
import { FakePhoenixPeer } from "../../../../packages/sdk/tests/fakePhoenixPeer";
import { ClaudeCodeDirs } from "../support/claudeCodeDirs";
import { ClaudeCodeSession } from "./support/claudeCode";

const USER = "user-1";
const ROOM = "room-1";
const MESSAGE = `@[[${AGENT_ID}]] hello`;

describe("a session's status", () => {
  it("is connecting until Claude Code completes its handshake, then connected, and gone once Claude Code exits", async () => {
    using dirs = new ClaudeCodeDirs();
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room(ROOM);
    const session = new ClaudeCodeSession(platform.link, { status: dirs.openStatus("session-1", DEFAULT_AGENT_NAME) });
    const initialized = session.holdInitialized();
    const connecting = session.connect();

    await initialized.sending;
    expect(dirs.session("session-1")).toMatchObject({
      agent: DEFAULT_AGENT_NAME,
      handle: AGENT_HANDLE,
      projectDir: dirs.projectDir,
      state: "connecting",
    });

    initialized.release();
    await connecting;
    await session.pushOf(await room.say(USER, MESSAGE));
    expect(dirs.session("session-1")).toMatchObject({ state: "connected" });

    expect(await session.leave()).toBe(EXIT_OK);
    expect(dirs.session("session-1")).toBeUndefined();
  });

  it("holds its agent while the platform is still answering who the agent is", async () => {
    using dirs = new ClaudeCodeDirs();
    const platform = BandPlatform.host([person(USER)]);
    const identity = platform.rest.agentMeHolds.hold(() => true);
    await using _session = new ClaudeCodeSession(platform.link, { status: dirs.openStatus("session-1", DEFAULT_AGENT_NAME) });

    await identity.sending;

    expect(await dirs.agents("status", "session-1")).toContain("default    ← this session");
    identity.release();
  });

  it("is refused, naming where the agent is connected, while another session holds it", async () => {
    using dirs = new ClaudeCodeDirs();
    await using peer = await FakePhoenixPeer.start({ rejectConflicts: true });
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room(ROOM);
    const waiting = room.postBeforeConnect(USER, MESSAGE);
    const link = { restApi: platform.rest };
    const credentials = { wsUrl: peer.url };
    await using first = await ClaudeCodeSession.connect(link, { credentials, status: dirs.openStatus("session-1", DEFAULT_AGENT_NAME) });
    await first.pushOf(waiting);

    const second = await ClaudeCodeSession.connect(link, { credentials, status: dirs.openStatus("session-2", DEFAULT_AGENT_NAME) });

    expect(await second.exited).toBe(EXIT_FAILED);
    expect(dirs.session("session-2")).toMatchObject({
      state: "refused",
      error: `Band agent "default" is already connected from another session (${dirs.projectDir}). Pick another with /band:agents use <name>.`,
    });
    expect(dirs.session("session-1")).toMatchObject({ state: "connected" });
  });

  it("is refused without a place when the session holding the agent keeps no status", async () => {
    using dirs = new ClaudeCodeDirs();
    await using peer = await FakePhoenixPeer.start({ rejectConflicts: true });
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room(ROOM);
    const waiting = room.postBeforeConnect(USER, MESSAGE);
    const link = { restApi: platform.rest };
    const credentials = { wsUrl: peer.url };
    await using elsewhere = await ClaudeCodeSession.connect(link, { credentials });
    await elsewhere.pushOf(waiting);

    const refused = await ClaudeCodeSession.connect(link, { credentials, status: dirs.openStatus("session-2", DEFAULT_AGENT_NAME) });

    expect(await refused.exited).toBe(EXIT_FAILED);
    expect(dirs.session("session-2")?.error).toBe(
      'Band agent "default" is already connected from another session. Pick another with /band:agents use <name>.',
    );
  });
});
