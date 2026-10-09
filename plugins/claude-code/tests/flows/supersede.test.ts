/**
 * The plugin's connection to Band over the real Phoenix wire: the last pick of
 * an agent takes it over, and leaving still reports a close that failed.
 */
import { describe, expect, it } from "vitest";

import { EXIT_FAILED } from "../../src/channel";
import { WS_URL_ENV } from "../../src/config";
import { AGENT_ID, BandPlatform, person } from "../../../../packages/sdk/tests/flows/support/bandPlatform";
import { FakePhoenixPeer } from "../../../../packages/sdk/tests/fakePhoenixPeer";
import { ClaudeCodeSession } from "./support/claudeCode";

const USER = "user-1";
const ROOM = "room-1";
const MESSAGE = `@[[${AGENT_ID}]] hello`;

describe("the connection to Band", () => {
  it("asks the platform to hand it the agent, even from a session already serving it", async () => {
    await using peer = await FakePhoenixPeer.start();
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room(ROOM);
    const waiting = room.postBeforeConnect(USER, MESSAGE);
    await using session = await ClaudeCodeSession.connect(() => ({ restApi: platform.rest }), { env: { [WS_URL_ENV]: peer.url } });
    await session.pushOf(waiting);

    expect(peer.connectionUrls.map((url) => new URL(url, peer.url).searchParams.get("on_conflict"))).toEqual(["supersede"]);
  });

  it("reports a failed close handshake instead of a successful exit when Claude Code leaves", async () => {
    await using peer = await FakePhoenixPeer.start();
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room(ROOM);
    const waiting = room.postBeforeConnect(USER, MESSAGE);
    await using session = await ClaudeCodeSession.connect(() => ({ restApi: platform.rest }), { env: { [WS_URL_ENV]: peer.url } });
    await session.pushOf(waiting);
    peer.stallReads();
    try {
      expect(await session.leave()).toBe(EXIT_FAILED);
      expect(peer.activeConnectionCount).toBe(1);
    } finally {
      peer.resumeReads();
      peer.severAllConnections();
    }
  });
});
