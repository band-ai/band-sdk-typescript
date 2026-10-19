import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { FakePhoenixPeer } from "./fakePhoenixPeer";
import { RecordLog } from "./testUtils";

type Frame = [string | null, string | null, string, string, { status?: string; response?: unknown }];

/** A bare protocol client: the peer's controls are proven without any SDK code in between. */
class WireClient implements AsyncDisposable {
  public readonly frames = new RecordLog<Frame>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.frames.record(JSON.parse(String(event.data)) as Frame));
  }

  public static async open(peer: FakePhoenixPeer): Promise<WireClient> {
    const socket = new WebSocket(`${peer.url}/websocket`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("peer connection failed")), { once: true });
    });
    return new WireClient(socket);
  }

  public push(joinRef: string, ref: string, event: string, topic = "t"): void {
    this.socket.send(JSON.stringify([joinRef, ref, topic, event, {}]));
  }

  /** The peer answers one connection's pushes in order, so a heartbeat reply proves everything pushed before it was handled. */
  public async drain(ref: string): Promise<void> {
    this.push("0", ref, "heartbeat", "phoenix");
    await this.frames.next((frame) => frame[1] === ref);
  }

  public replies(): string[] {
    return this.frames.entries.filter((frame) => frame[3] === "phx_reply" && frame[2] !== "phoenix").map((frame) => `${frame[1]}:${frame[4].status}`);
  }

  public close(): void {
    this.socket.close();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }
}

async function started() {
  const peer = await FakePhoenixPeer.start();
  return { peer, async [Symbol.asyncDispose]() { await peer.stop(); } };
}

describe("FakePhoenixPeer leave controls", () => {
  it("records each leave with its connection, join ref and ref, and acknowledges it by default", async () => {
    await using kit = await started();
    await using first = await WireClient.open(kit.peer);
    await using second = await WireClient.open(kit.peer);
    first.push("j1", "r1", "phx_leave");
    second.push("j2", "r1", "phx_leave");
    await first.frames.next((frame) => frame[1] === "r1");
    await second.frames.next((frame) => frame[1] === "r1");
    expect(kit.peer.leaves.entries).toEqual([
      { event: "phx_leave", connection: 1, topic: "t", joinRef: "j1", ref: "r1" },
      { event: "phx_leave", connection: 2, topic: "t", joinRef: "j2", ref: "r1" },
    ]);
    expect(first.replies()).toEqual(["r1:ok"]);
    expect(second.replies()).toEqual(["r1:ok"]);
  });

  it("holds a leave reply until its exact request is acknowledged or rejected, on its own connection only", async () => {
    await using kit = await started();
    await using first = await WireClient.open(kit.peer);
    await using second = await WireClient.open(kit.peer);
    kit.peer.queueLeaveOutcomes("t", ["pending", "pending", "pending"]);
    first.push("j1", "r1", "phx_leave");
    await first.drain("h1");
    second.push("j2", "r1", "phx_leave");
    await second.drain("h1");
    first.push("j1", "r2", "phx_leave");
    await first.drain("h2");
    expect(first.replies()).toEqual([]);
    expect(second.replies()).toEqual([]);

    const [firstHeld, secondHeld, firstLater] = kit.peer.leaves.entries;
    kit.peer.settleRequest(secondHeld!, "error", { reason: "rejected" });
    await second.frames.next((frame) => frame[1] === "r1");
    await first.drain("h3");
    expect(second.replies()).toEqual(["r1:error"]);
    expect(second.frames.entries.find((frame) => frame[1] === "r1")![4]).toEqual({ status: "error", response: { reason: "rejected" } });
    expect(first.replies()).toEqual([]);

    kit.peer.settleRequest(firstLater!, "ok");
    kit.peer.settleRequest(firstHeld!, "ok");
    await first.frames.next((frame) => frame[1] === "r1");
    expect(first.replies()).toEqual(["r2:ok", "r1:ok"]);
    expect(second.frames.entries.filter((frame) => frame[1] === "r2")).toEqual([]);
  });

  it("refuses to answer a request twice, or one whose connection is gone", async () => {
    await using kit = await started();
    await using client = await WireClient.open(kit.peer);
    kit.peer.queueLeaveOutcomes("t", ["pending", "pending"]);
    client.push("j", "r1", "phx_leave");
    client.push("j", "r2", "phx_leave");
    await client.drain("h");
    const [answered, lost] = kit.peer.leaves.entries;
    kit.peer.settleRequest(answered!, "ok");
    expect(() => kit.peer.settleRequest(answered!, "ok")).toThrow("no longer pending");
    kit.peer.severAllConnections();
    expect(() => kit.peer.settleRequest(lost!, "ok")).toThrow("no longer pending");
  });

  it("refuses to answer a request whose connection the client closed", async () => {
    await using kit = await started();
    await using client = await WireClient.open(kit.peer);
    kit.peer.queueLeaveOutcomes("t", ["pending"]);
    client.push("j", "r1", "phx_leave");
    await client.drain("h");
    const [held] = kit.peer.leaves.entries;
    const cursor = kit.peer.closed.entries.length;
    client.close();
    await kit.peer.closed.next(() => true, cursor);
    expect(() => kit.peer.settleRequest(held!, "ok")).toThrow("no longer pending");
  });

  it("applies queued leave outcomes per topic in order and then acknowledges, leaving joins alone", async () => {
    await using kit = await started();
    await using client = await WireClient.open(kit.peer);
    kit.peer.queueLeaveOutcomes("t", ["error", "pending"]);
    client.push("j", "r1", "phx_leave");
    client.push("j", "r2", "phx_leave");
    client.push("j", "r3", "phx_leave");
    client.push("j", "r4", "phx_join");
    client.push("j", "r5", "phx_leave", "other");
    await client.frames.next((frame) => frame[1] === "r5");
    expect(client.replies()).toEqual(["r1:error", "r3:ok", "r4:ok", "r5:ok"]);
    expect(kit.peer.leaves.entries.map((request) => `${request.topic}:${request.ref}`)).toEqual(["t:r1", "t:r2", "t:r3", "other:r5"]);
    expect(kit.peer.joins.entries.map((request) => request.ref)).toEqual(["r4"]);
  });
});
