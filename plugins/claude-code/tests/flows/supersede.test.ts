/**
 * Another client takes the agent over the real Phoenix wire: the plugin must
 * exit rather than keep serving Band tools on a connection the platform closed.
 */
import { describe, expect, it, vi } from "vitest";
import { PlatformRuntime } from "@band-ai/sdk/runtime";

import { EXIT_FAILED } from "../../src/channel";
import { AGENT_ID, BandPlatform, person } from "../../../../packages/sdk/tests/flows/support/bandPlatform";
import { FakePhoenixPeer } from "../../../../packages/sdk/tests/fakePhoenixPeer";
import { PhoenixChannelsTransport } from "../../../../packages/sdk/src/platform/streaming/PhoenixChannelsTransport";
import { NoopLogger } from "../../../../packages/sdk/src/core/logger";
import { AGENT_API_KEY } from "../../../../packages/sdk/tests/flows/support/bandPlatform";
import { ClaudeCodeSession } from "./support/claudeCode";

const USER = "user-1";
const ROOM = "room-1";
const MESSAGE = `@[[${AGENT_ID}]] hello`;

describe("when another client takes the agent", () => {
  it("connects asking the platform to refuse it, not displace a session already serving", async () => {
    await using peer = await FakePhoenixPeer.start();
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room(ROOM);
    const waiting = room.postBeforeConnect(USER, MESSAGE);
    await using session = await ClaudeCodeSession.connect({ restApi: platform.rest }, { credentials: { wsUrl: peer.url } });
    await session.pushOf(waiting);

    expect(peer.connectionUrls.map((url) => new URL(url, peer.url).searchParams.get("on_conflict"))).toEqual(["reject"]);
  });

  it("exits with a failure once it is serving", async () => {
    await using peer = await FakePhoenixPeer.start();
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room(ROOM);
    const waiting = room.postBeforeConnect(USER, MESSAGE);
    await using session = await ClaudeCodeSession.connect({ restApi: platform.rest }, { credentials: { wsUrl: peer.url } });
    await session.pushOf(waiting);
    expect(await room.outcome(waiting)).toBe("processed");

    await peer.supersede(AGENT_ID);

    expect(await session.exited).toBe(EXIT_FAILED);
  });

  it("reports a failed close handshake instead of a successful exit when Claude Code leaves", async () => {
    await using peer = await FakePhoenixPeer.start();
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room(ROOM);
    const waiting = room.postBeforeConnect(USER, MESSAGE);
    const transport = new PhoenixChannelsTransport({ wsUrl: peer.url, apiKey: AGENT_API_KEY, agentId: AGENT_ID });
    await using session = await ClaudeCodeSession.connect({ restApi: platform.rest, transport });
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

  it("keeps the original runtime error when closing the socket also fails", async () => {
    await using peer = await FakePhoenixPeer.start();
    const platform = BandPlatform.host([person(USER)]);
    await platform.room(ROOM);
    const failure = new Error("Band runtime failed while serving");
    const running = vi.spyOn(PlatformRuntime.prototype, "runForever").mockImplementation(async () => {
      peer.stallReads();
      throw failure;
    });
    const transport = new PhoenixChannelsTransport({ wsUrl: peer.url, apiKey: AGENT_API_KEY, agentId: AGENT_ID });
    const logger = new NoopLogger();
    const report = vi.spyOn(logger, "error");
    await using session = await ClaudeCodeSession.connect({ restApi: platform.rest, transport }, { logger });
    try {
      expect(await session.exited).toBe(EXIT_FAILED);
      expect(report).toHaveBeenCalledWith("Band channel stopped", {
        error: failure,
      });
      expect(peer.activeConnectionCount).toBe(1);
    } finally {
      running.mockRestore();
      peer.resumeReads();
      peer.severAllConnections();
    }
  });
});
