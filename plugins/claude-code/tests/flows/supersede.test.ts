/**
 * Another client takes the agent over the real Phoenix wire: the plugin must
 * exit rather than keep serving Band tools on a connection the platform closed.
 */
import { describe, expect, it } from "vitest";

import { EXIT_FAILED } from "../../src/channel";
import { AGENT_ID, BandPlatform, person } from "../../../../packages/sdk/tests/flows/support/bandPlatform";
import { FakePhoenixPeer } from "../../../../packages/sdk/tests/fakePhoenixPeer";
import { ClaudeCodeSession } from "./support/claudeCode";

const USER = "user-1";

describe("when another client takes the agent", () => {
  it("exits with a failure once it is serving", async () => {
    await using peer = await FakePhoenixPeer.start();
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room("room-1");
    const waiting = room.leave(USER, `@[[${AGENT_ID}]] hello`);
    await using session = await ClaudeCodeSession.connect({ restApi: platform.rest }, { wsUrl: peer.url });
    await session.pushOf(waiting);
    expect(await room.outcome(waiting)).toBe("processed");

    await peer.supersede(AGENT_ID);

    expect(await session.exited).toBe(EXIT_FAILED);
  });
});
