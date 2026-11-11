import { describe, expect, it } from "vitest";

import { RoomExecutionStoppedError } from "../src/core/errors";
import { BandLink } from "../src/platform/BandLink";
import { activityPeer, json, type ActivityRequest } from "./support/activityPeer";
import { FakeTransport, RecordLog } from "./testUtils";

const ROOM = "room-1";
const MESSAGE = "msg-1";

/** Band's answer to an agent write in a room it stopped the agent in: 204 for a claim or acknowledgement, 403 for a post. */
function stoppedBand({ request, response }: ActivityRequest): void {
  if (request.url?.endsWith("/processing") || request.url?.endsWith("/processed") || request.url?.endsWith("/failed")) {
    response.writeHead(204);
    response.end();
    return;
  }
  json(response, { error: { code: "forbidden", message: "Agent execution is stopped in this room" } }, 403);
}

describe("Band refusing writes in a room it stopped the agent in, over HTTP", () => {
  it.each([
    ["markMessageProcessing", (rest: Awaited<ReturnType<typeof activityPeer>>["rest"]) => rest.markMessageProcessing(ROOM, MESSAGE)],
    ["markMessageProcessed", (rest: Awaited<ReturnType<typeof activityPeer>>["rest"]) => rest.markMessageProcessed(ROOM, MESSAGE)],
    ["markMessageFailed", (rest: Awaited<ReturnType<typeof activityPeer>>["rest"]) => rest.markMessageFailed(ROOM, MESSAGE, "boom")],
    ["createChatMessage", (rest: Awaited<ReturnType<typeof activityPeer>>["rest"]) => rest.createChatMessage(ROOM, { content: "hi", mentions: [{ id: "user-1" }] })],
    ["createChatEvent", (rest: Awaited<ReturnType<typeof activityPeer>>["rest"]) => rest.createChatEvent(ROOM, { content: "thinking", messageType: "thought" })],
  ])("%s rejects with RoomExecutionStoppedError for the room", async (_name, call) => {
    await using peer = await activityPeer(stoppedBand);

    const refused = await call(peer.rest).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(RoomExecutionStoppedError);
    expect((refused as RoomExecutionStoppedError).roomId).toBe(ROOM);
  });

  it("leaves a claim Band accepts, and a post it forbids for another reason, as they were", async () => {
    await using peer = await activityPeer(({ request, response }) => {
      if (request.url?.endsWith("/processing")) return json(response, { data: { id: MESSAGE } });
      json(response, { error: { code: "forbidden", message: "Not a participant" } }, 403);
    });

    await expect(peer.rest.markMessageProcessing(ROOM, MESSAGE)).resolves.toBeDefined();
    const refused = await peer.rest.createChatMessage(ROOM, { content: "hi", mentions: [{ id: "user-1" }] }).catch((error: unknown) => error);
    expect(refused).not.toBeInstanceOf(RoomExecutionStoppedError);
    expect(refused).toMatchObject({ statusCode: 403 });
  });

  it("tells the link's stop listeners about a refused best-effort claim, which still resolves", async () => {
    await using peer = await activityPeer(stoppedBand);
    const link = new BandLink({ agentId: "agent", apiKey: "secret-test-key", restUrl: peer.origin, transport: new FakeTransport() });
    const stopped = new RecordLog<string>();
    link.onExecutionStopped((roomId) => stopped.record(roomId));

    await link.markProcessing(ROOM, MESSAGE, { bestEffort: true });

    expect(stopped.entries).toEqual([ROOM]);
  });
});
