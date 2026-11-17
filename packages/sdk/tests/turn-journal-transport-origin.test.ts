import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { afterEach, describe, expect, it } from "vitest";

import type { AdapterToolsProtocol } from "../src/contracts/protocols";
import type { BandMcpBackend } from "../src/mcp/backends";
import { createBandMcpBackend } from "../src/mcp/backends";
import { createBandSdkMcpServer, type BandSdkMcpServer } from "../src/mcp/sdk";
import { PlatformRuntime } from "../src/runtime";
import type { GenericAdapterHandler } from "../src/adapters/GenericAdapter";
import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { IDENTITY, recordTypes, roomFile } from "./turnJournalSupport";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { tmpRoot } from "./testUtils";
import { createDeferred } from "../src/core/deferred";

const OWNER = "owner";
const ROOM = "room-1";
const MENTION = `@[[${AGENT_ID}]]`;

/**
 * A turn that answers through `answer`, then keeps the room until the test
 * releases it, so the test's own call lands while the turn stands. It keeps
 * the room by not returning; reporting the hold through `holdRoomUntil` would
 * mark the turn detached, whose `turn.done` the runtime skips — and the
 * handler's args carry no `holdRoomUntil` at all.
 */
function holdingAnswer(
  tools: { current: AdapterToolsProtocol | undefined },
  started: { promise: Promise<void>; resolve(): void },
  held: { promise: Promise<void>; resolve(): void },
  answer: (tools: AdapterToolsProtocol) => Promise<unknown>,
): GenericAdapterHandler {
  return async (args) => {
    tools.current = args.tools;
    started.resolve();
    await answer(args.tools);
    await held.promise;
  };
}

type DeferredFlag = ReturnType<typeof createDeferred>;

/**
 * Drives a long-lived Band MCP bridge from a context that is not the turn's:
 * the bridge's own dispatch (an in-memory pair the test awaits, or the loop
 * of an HTTP server that outlives its turns) runs outside the turn's scope,
 * as every real long-lived transport does.
 */
async function inProcessBridgeCall(
  bridge: BandSdkMcpServer,
  call: { name: string; arguments: Record<string, unknown> },
) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await bridge.serverConfig.instance.connect(serverTransport);
  const client = new Client({ name: "transport-origin-test", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name: call.name, arguments: call.arguments });
  } finally {
    await client.close();
  }
}

describe("a journaled reply made through a long-lived transport settles under the turn that runs, not the context the transport was created in", () => {
  let platform: BandPlatform | undefined;
  let journalDir: string;
  afterEach(async () => {
    if (platform !== undefined) await platform[Symbol.asyncDispose]();
  });

  it("settles a cold bridge's reply under the running turn (in-process dispatch)", async () => {
    platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    journalDir = tmpRoot();

    // The bridge stands before any turn exists: its dispatch context knows no turn.
    const tools: { current: AdapterToolsProtocol | undefined } = { current: undefined };
    const backend = await createBandMcpBackend({
      kind: "sdk",
      enableMemoryTools: false,
      getToolsForRoom: () => tools.current,
      multiRoom: false,
    });
    const bridge = backend.server as BandSdkMcpServer;

    const started = createDeferred<void>();
    const held = createDeferred<void>();
    const runtime = new PlatformRuntime({
      agentId: AGENT_ID,
      apiKey: AGENT_API_KEY,
      linkOptions: platform.link,
      agentConfig: { autoSubscribeExistingRooms: true },
      sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY },
    });
    const stop = runtime.start(new GenericAdapter(holdingAnswer(tools, started, held, async () => undefined)));
    const completed = turnCompleted(runtime);
    await room.say(OWNER, `${MENTION} hello`);
    await started.promise;
    // The call lands from the test's own context: no turn scope stands in it.
    const result = await inProcessBridgeCall(bridge, {
      name: "band_send_message",
      arguments: { room_id: ROOM, content: "cold bridge reply", mentions: ["@owner"] },
    });
    expect(result.isError ?? false).toBe(false);
    held.resolve();
    await completed;
    await stop;
    await runtime.stop();
    // The reply stands settled under the turn it landed in — recorded, so a
    // restart settles the message from the journal and answers it no second time.
    expect((await recordTypes(roomFile(journalDir, IDENTITY, AGENT_ID, ROOM)))).toEqual(["reply.intent", "reply.settled", "turn.done"]);

    const postedBefore = room.posted.length;
    const successor = new PlatformRuntime({
      agentId: AGENT_ID,
      apiKey: AGENT_API_KEY,
      linkOptions: platform.link,
      agentConfig: { autoSubscribeExistingRooms: true },
      sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY },
    });
    const events: string[] = [];
    successor.observe((event) => events.push(event.type));
    const successorStop = successor.start(new GenericAdapter(async () => undefined));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await successorStop;
    await successor.stop();
    expect(room.posted.length).toBe(postedBefore);
    expect(events).not.toContain("turn.started");
  });

  it("settles a warm bridge's reply under the turn that runs, not the turn the bridge was opened in (in-process dispatch)", async () => {
    platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    journalDir = tmpRoot();

    const tools: { current: AdapterToolsProtocol | undefined } = { current: undefined };
    let bridge: BandSdkMcpServer | undefined;
    // A dispatch loop created inside the first turn: it keeps the first
    // turn's scope, as every loop a turn opens does.
    let tick: ReturnType<typeof setInterval> | undefined;
    let pendingCall: (() => Promise<unknown>) | undefined;

    const runtime = new PlatformRuntime({
      agentId: AGENT_ID,
      apiKey: AGENT_API_KEY,
      linkOptions: platform.link,
      agentConfig: { autoSubscribeExistingRooms: true },
      sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY },
    });

    let turn = 0;
    let inSecondTurn = false;
    const stop = runtime.start(new GenericAdapter(async (args) => {
      turn += 1;
      tools.current = args.tools;
      if (turn === 2) inSecondTurn = true;
      if (turn === 1) {
        // Open the bridge inside the first turn, so its dispatch context is
        // that turn's scope.
        const backend = await createBandMcpBackend({
          kind: "sdk",
          enableMemoryTools: false,
          getToolsForRoom: () => tools.current,
          multiRoom: false,
        });
        bridge = backend.server as BandSdkMcpServer;
        tick = setInterval(() => {
          // Dispatch only once the second turn has stood its tools, so the
          // call cannot race onto the first turn's (now stale) tools.
          if (pendingCall !== undefined && inSecondTurn) {
            const call = pendingCall;
            pendingCall = undefined;
            void call().catch(() => undefined);
          }
        }, 5);
        await args.tools.sendMessage("first answer", ["@owner"]);
      }
    }));

    const firstReplyHeld = platform.rest.messageHolds.hold((roomId, content) => roomId === ROOM && content === "second answer");
    const messageOne = await room.say(OWNER, `${MENTION} one`);
    // Wait for the first turn to stand its answer and end.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bridge).toBeDefined();
    // The second turn's reply goes out the bridge, dispatched by the loop the
    // first turn created.
    pendingCall = () => inProcessBridgeCall(bridge!, {
      name: "band_send_message",
      arguments: { room_id: ROOM, content: "second answer", mentions: ["@owner"] },
    });
    const messageTwo = await room.say(OWNER, `${MENTION} two`);
    await firstReplyHeld.sending;
    firstReplyHeld.release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stop;
    await runtime.stop();
    tick?.unref();
    clearInterval(tick);

    // Both answers stand in the journal, and the second under the second
    // message — not the first, whose scope the bridge's dispatch kept.
    const inbounds = await readJournalInbounds(journalDir);
    const first = inbounds.find((inbound) => inbound.messageId === messageOne);
    const second = inbounds.find((inbound) => inbound.messageId === messageTwo);
    expect(first?.settled.length).toBe(1);
    expect(second?.settled.length).toBe(1);
  });

  it("settles a cold bridge's reply under the running turn over HTTP (the transport that outlives its turns)", async () => {
    platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    journalDir = tmpRoot();

    const tools: { current: AdapterToolsProtocol | undefined } = { current: undefined };
    const backend = await createBandMcpBackend({
      kind: "http",
      enableMemoryTools: false,
      getToolsForRoom: () => tools.current,
      multiRoom: false,
    });
    const server = backend.server as { url?: string | null; stop(): Promise<void> };
    expect(server.url).toBeTruthy();

    const started = createDeferred<void>();
    const held = createDeferred<void>();
    const runtime = new PlatformRuntime({
      agentId: AGENT_ID,
      apiKey: AGENT_API_KEY,
      linkOptions: platform.link,
      agentConfig: { autoSubscribeExistingRooms: true },
      sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY },
    });
    const stop = runtime.start(new GenericAdapter(holdingAnswer(tools, started, held, async () => undefined)));
    const completed = turnCompleted(runtime);
    await room.say(OWNER, `${MENTION} hello`);
    await started.promise;

    const transport = new StreamableHTTPClientTransport(new URL(server.url!), {
      requestInit: { headers: { Authorization: `Bearer ${backend.authToken}` } },
    });
    const client = new Client({ name: "transport-origin-http", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.callTool({
      name: "band_send_message",
      arguments: { room_id: ROOM, content: "http bridge reply", mentions: ["@owner"] },
    });
    expect(result.isError ?? false).toBe(false);
    await transport.close();
    held.resolve();
    await completed;
    await stop;
    await runtime.stop();
    await server.stop();

    expect((await recordTypes(roomFile(journalDir, IDENTITY, AGENT_ID, ROOM)))).toEqual(["reply.intent", "reply.settled", "turn.done"]);
  });

  it("settles a bridge decline under the running turn", async () => {
    platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    journalDir = tmpRoot();

    const tools: { current: AdapterToolsProtocol | undefined } = { current: undefined };
    const backend = await createBandMcpBackend({
      kind: "sdk",
      enableMemoryTools: false,
      getToolsForRoom: () => tools.current,
      multiRoom: false,
    });
    const bridge = backend.server as BandSdkMcpServer;

    const started = createDeferred<void>();
    const held = createDeferred<void>();
    const runtime = new PlatformRuntime({
      agentId: AGENT_ID,
      apiKey: AGENT_API_KEY,
      linkOptions: platform.link,
      agentConfig: { autoSubscribeExistingRooms: true },
      sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY },
    });
    const stop = runtime.start(new GenericAdapter(holdingAnswer(tools, started, held, async () => undefined)));
    const completed = turnCompleted(runtime);
    await room.say(OWNER, `${MENTION} hello`);
    await started.promise;
    const result = await inProcessBridgeCall(bridge, {
      name: "band_no_reply",
      arguments: { room_id: ROOM, reason: "nothing to add" },
    });
    expect(result.isError ?? false).toBe(false);
    held.resolve();
    await completed;
    await stop;
    await runtime.stop();

    expect((await recordTypes(roomFile(journalDir, IDENTITY, AGENT_ID, ROOM)))).toEqual(["decline.settled", "turn.done"]);

    const postedBefore = room.posted.length;
    const successor = new PlatformRuntime({
      agentId: AGENT_ID,
      apiKey: AGENT_API_KEY,
      linkOptions: platform.link,
      agentConfig: { autoSubscribeExistingRooms: true },
      sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY },
    });
    const events: string[] = [];
    successor.observe((event) => events.push(event.type));
    const successorStop = successor.start(new GenericAdapter(async () => undefined));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await successorStop;
    await successor.stop();
    expect(room.posted.length).toBe(postedBefore);
    expect(events).not.toContain("turn.started");
  });

  it("settles a warm HTTP bridge's reply under the turn that runs, not the one that opened it", async () => {
    platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    journalDir = tmpRoot();

    const tools: { current: AdapterToolsProtocol | undefined } = { current: undefined };
    let backend: BandMcpBackend | undefined;

    const runtime = new PlatformRuntime({
      agentId: AGENT_ID,
      apiKey: AGENT_API_KEY,
      linkOptions: platform.link,
      agentConfig: { autoSubscribeExistingRooms: true },
      sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY },
    });

    let turn = 0;
    const turnTwoReady = createDeferred<void>();
    const stop = runtime.start(new GenericAdapter(async (args) => {
      turn += 1;
      tools.current = args.tools;
      if (turn === 2) turnTwoReady.resolve();
      if (turn === 1) {
        // The HTTP server's loop is created inside the first turn: requests
        // it serves later run in that turn's scope, as the process's.
        backend = await createBandMcpBackend({
          kind: "http",
          enableMemoryTools: false,
          getToolsForRoom: () => tools.current,
          multiRoom: false,
        });
        await args.tools.sendMessage("first answer", ["@owner"]);
      }
    }));

    const messageOne = await room.say(OWNER, `${MENTION} one`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(backend).toBeDefined();
    const server = backend!.server as { url: string };

    const hold = platform.rest.messageHolds.hold((roomId, content) => roomId === ROOM && content === "second answer");
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${backend!.authToken}` } },
    });
    const client = new Client({ name: "warm-http-bridge", version: "1.0.0" });
    await client.connect(transport);
    const messageTwo = await room.say(OWNER, `${MENTION} two`);
    await turnTwoReady.promise;
    const call = client.callTool({
      name: "band_send_message",
      arguments: { room_id: ROOM, content: "second answer", mentions: ["@owner"] },
    });
    // The call blocks on the post the platform holds; release it in parallel.
    await hold.sending;
    hold.release();
    const result = await call;
    expect(result.isError ?? false).toBe(false);
    await transport.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stop;
    await runtime.stop();
    await (backend!.server as { stop(): Promise<void> }).stop();

    // The warm server's loop ran in the first turn's scope; the reply still
    // stands under the second message, with one settled publication each.
    const inbounds = await readJournalInbounds(journalDir);
    const first = inbounds.find((inbound) => inbound.messageId === messageOne);
    const second = inbounds.find((inbound) => inbound.messageId === messageTwo);
    expect(first?.settled.length).toBe(1);
    expect(second?.settled.length).toBe(1);
  });
});

/** Resolves once the runtime reports the turn it was observing as completed. */
function turnCompleted(runtime: PlatformRuntime): Promise<void> {
  return new Promise((resolve) => {
    runtime.observe((event) => {
      if (event.type === "turn.completed") resolve();
    });
  });
}

/** The journal's settlement by inbound: which publications each message's replies stand as. */
async function readJournalInbounds(journalDir: string): Promise<Array<{ messageId: string; settled: string[] }>> {
  const file = roomFile(journalDir, IDENTITY, AGENT_ID, ROOM);
  const { readFile } = await import("node:fs/promises");
  const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line !== "");
  const records = lines.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);
  const byMessage = new Map<string, { messageId: string; settled: string[] }>();
  for (const record of records) {
    const messageId = String(record.messageId);
    const entry = byMessage.get(messageId) ?? { messageId, settled: [] };
    if (record.t === "reply.settled") entry.settled.push(String(record.publicationId));
    byMessage.set(messageId, entry);
  }
  return [...byMessage.values()];
}