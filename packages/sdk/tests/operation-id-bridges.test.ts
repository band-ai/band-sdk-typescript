import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { describe, expect, it, onTestFinished } from "vitest";

import { GenericAdapter, type GenericAdapterHandler } from "../src/adapters/GenericAdapter";
import { createDeferred } from "../src/core/deferred";
import { relayReply, type TurnTools } from "../src/core/turn";
import { createBandMcpBackend, type BandMcpBackend } from "../src/mcp/backends";
import { ContactCallbackTools } from "../src/runtime/tools/ContactCallbackTools";
import { PlatformRuntime } from "../src/runtime";
import type { SessionConfig } from "../src/runtime/types";
import { FakeRestApi, tmpRoot } from "./testUtils";
import { IDENTITY, recordTypes, roomFile } from "./turnJournalSupport";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";

const OWNER = "owner";
const MENTION = `@[[${AGENT_ID}]]`;
const KILL = 0;

type NetworkKind = "http" | "sse";

/**
 * Starts a runtime whose rooms each hold an inbound turn message, so a turn runs
 * per room the moment the runtime connects. The handler receives each turn's live
 * tools and room, and hands them to a real registered backend of `kind`.
 */
async function runtimeWithNetworkBackend(
  kind: NetworkKind,
  handler: GenericAdapterHandler,
  options: { rooms?: string[] } = {},
) {
  const rooms = options.rooms ?? ["room-1"];
  const platform = BandPlatform.host([person(OWNER)]);
  for (const roomId of rooms) {
    const room = await platform.room(roomId);
    room.postBeforeConnect(OWNER, `${MENTION} review ${roomId}`);
  }
  const journalDir = tmpRoot();
  const runtime = new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    linkOptions: platform.link,
    agentConfig: { autoSubscribeExistingRooms: true },
    sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY } as SessionConfig,
  });
  onTestFinished(async () => {
    if (runtime.state.status === "running") await runtime.stop(KILL);
  });
  await runtime.start(new GenericAdapter(handler));
  return { platform, runtime, journalDir };
}

async function connectClient(backend: BandMcpBackend, name: string): Promise<Client> {
  const server = backend.server as { url?: string; sseUrl?: string };
  let transport: Transport;
  if (backend.kind === "http") {
    transport = new StreamableHTTPClientTransport(new URL(server.url!), {
      requestInit: { headers: { authorization: `Bearer ${backend.authToken}` } },
    });
  } else {
    transport = new SSEClientTransport(new URL(server.sseUrl!), {
      requestInit: { headers: { authorization: `Bearer ${backend.authToken}` } },
    });
  }
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const postedContents = (platform: BandPlatform, roomId?: string) =>
  platform.rest.posted.entries
    .filter(({ messageType }) => messageType !== "error")
    .filter((entry) => roomId === undefined || entry.roomId === roomId)
    .map(({ content }) => content);

async function until(predicate: () => boolean | Promise<boolean>, timeout = 30000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("the awaited state never stood");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const kind of ["http", "sse"] as const) {
  describe(`the ${kind} backend's keyed admission`, () => {
    it(`pins the actual turn's tools across the validation await, so a successor room never receives the post`, async () => {
      const platform = BandPlatform.host([person(OWNER)]);
      const firstRoom = await platform.room("origin-room");
      const secondRoom = await platform.room("successor-room");
      firstRoom.postBeforeConnect(OWNER, `${MENTION} original turn`);
      secondRoom.postBeforeConnect(OWNER, `${MENTION} keep successor live`);
      const journalDir = tmpRoot();
      const successorReady = createDeferred<TurnTools>();
      const releaseSuccessor = createDeferred<void>();
      const observed = createDeferred<unknown>();
      const runtime = new PlatformRuntime({
        agentId: AGENT_ID,
        apiKey: AGENT_API_KEY,
        linkOptions: platform.link,
        agentConfig: { autoSubscribeExistingRooms: true },
        sessionConfig: { journalDir, journalPlatformIdentity: IDENTITY } as SessionConfig,
      });
      onTestFinished(async () => {
        releaseSuccessor.resolve();
        if (runtime.state.status === "running") await runtime.stop(KILL);
      });
      await runtime.start(
        new GenericAdapter(async ({ tools, roomId }) => {
          if (roomId === "successor-room") {
            successorReady.resolve(tools);
            await releaseSuccessor.promise;
            return;
          }
          try {
            const successor = await successorReady.promise;
            let active: TurnTools = tools;
            let switchAfterAdmission = false;
            const backend = await createBandMcpBackend({
              kind,
              enableMemoryTools: false, enableOperationIds: true,
              multiRoom: false,
              getToolsForRoom: () => {
                const snapshot = active;
                if (switchAfterAdmission) {
                  switchAfterAdmission = false;
                  // The room turns while the call's validation is in flight: the
                  // resolver now stands for the successor's tools.
                  queueMicrotask(() => {
                    active = successor;
                  });
                }
                return snapshot;
              },
            });
            onTestFinished(async () => {
              await backend.stop();
            });
            const client = await connectClient(backend, `origin-${kind}`);
            switchAfterAdmission = true;
            await client.callTool({
              name: "band_send_message",
              arguments: { content: "must stay with original tools", mentions: [OWNER], operation_id: `origin-${kind}-key` },
            });
            observed.resolve(undefined);
          } catch (error) {
            observed.resolve(error);
          } finally {
            releaseSuccessor.resolve();
          }
        }),
      );
      const observation = await observed.promise;
      expect(observation, "the keyed call never failed").toBeUndefined();
      // The post stands in the origin room on the tools the turn stood on: the
      // resolver's later successor value never received it.
      await until(() => postedContents(platform).includes("must stay with original tools"));
      expect(postedContents(platform, "origin-room")).toEqual(["must stay with original tools"]);
      expect(postedContents(platform, "successor-room")).toEqual([]);
    }, 90000);

    it(`refuses a keyed call whose admission guard stands retired: no post, no re-resolution, and the turn's reply still stands`, async () => {
      let retiredError: boolean | undefined;
      let retiredText = "";
      let relayed: boolean | undefined;
      let done = false;
      const { platform } = await runtimeWithNetworkBackend(kind, async ({ tools }) => {
        let live = true;
        const backend = await createBandMcpBackend({
          kind,
          enableMemoryTools: false, enableOperationIds: true,
          getToolsForRoom: () => tools,
          admissionGuard: () => live,
        });
        onTestFinished(async () => {
          await backend.stop();
        });
        const client = await connectClient(backend, `guard-${kind}`);
        try {
          // The generation retires before any keyed call is admitted.
          live = false;
          const retired = await client.callTool({
            name: "band_send_message",
            arguments: { room_id: "room-1", content: "retired must refuse", mentions: [OWNER], operation_id: `guard-${kind}-key` },
          });
          retiredError = Boolean(retired.isError);
          retiredText = (retired.content as Array<{ text: string }>)[0]?.text ?? "";
          // A retired generation fences nothing: the turn's closing relay stands.
          relayed = await relayReply(tools, "closing reply stands", [OWNER]);
        } finally {
          await client.close();
          done = true;
        }
      });
      await until(() => done);
      // The refused call stands with a clean text: no post, no re-resolution. A
      // generation that retired before the call admits no origin and fences no turn.
      expect(retiredError).toBe(true);
      expect(retiredText).toBeTruthy();
      expect(relayed).toBe(true);
      expect(postedContents(platform)).toEqual(["closing reply stands"]);
    }, 90000);
  });
}

describe("room-scoped no-reply over the wire", () => {
  it("advertises room_id on band_no_reply, and a keyed decline for the selected room settles that room's turn under the key", async () => {
    const successorReady = createDeferred<TurnTools>();
    const releaseSuccessor = createDeferred<void>();
    const observed = createDeferred<{ declineError?: boolean; relayed: boolean }>();
    onTestFinished(async () => {
      releaseSuccessor.resolve();
    });
    const { platform, journalDir } = await runtimeWithNetworkBackend("http", async ({ tools, roomId }) => {
      if (roomId === "room-2") {
        // The selected room's turn must stand live for its tools to resolve: it
        // holds until the caller's decline settles it or the test ends.
        successorReady.resolve(tools);
        await releaseSuccessor.promise;
        return;
      }
      const otherTools = await successorReady.promise;
      const backend = await createBandMcpBackend({
        kind: "http",
        enableMemoryTools: false, enableOperationIds: true,
        getToolsForRoom: (otherRoomId: string) =>
          otherRoomId === "room-1" ? tools : otherRoomId === "room-2" ? otherTools : undefined,
      });
      onTestFinished(async () => {
        await backend.stop();
      });
      const client = await connectClient(backend, "no-reply-room");
      try {
        const listed = await client.listTools();
        const noReply = listed.tools.find((tool) => tool.name === "band_no_reply");
        const schema = noReply?.inputSchema as { properties?: Record<string, unknown> } | undefined;
        expect(schema?.properties, "band_no_reply must advertise room_id to a room-scoped server").toHaveProperty("room_id");

        // The call selects room-2 from its argument: that room's turn stands
        // declined durably; this turn — keyed on the call's field — fences its
        // own closing text.
        const result = await client.callTool({
          name: "band_no_reply",
          arguments: { room_id: "room-2", reason: "other room is fyi only", operation_id: "no-reply-room-key" },
        });
        const relayed = await relayReply(tools, "own closing text", [OWNER]);
        observed.resolve({ declineError: Boolean(result.isError), relayed });
      } finally {
        await client.close();
      }
    }, { rooms: ["room-1", "room-2"] });
    const outcome = await observed.promise;
    expect(outcome.declineError).toBe(false);
    // The decline stood in the selected room, which is where a keyed call's
    // closing-text fence lands: room-2's turn is fenced, and nothing posts in it.
    expect(postedContents(platform, "room-2")).toEqual([]);
    // The caller's room is unaffected: its closing text stands.
    expect(outcome.relayed).toBe(true);
    expect(postedContents(platform, "room-1")).toEqual(["own closing text"]);
    // The selected room's durable record stands: its operation settled as a
    // decline. Its turn.done record lands when that turn's blocked handler is
    // released at test end, so the three decline records are the assertion.
    const records = await recordTypes(roomFile(journalDir, IDENTITY, AGENT_ID, "room-2"));
    expect(records).toContain("op.reserved");
    expect(records).toContain("op.settled");
    expect(records).toContain("decline.settled");
  }, 90000);

  it("does not advertise room_id on band_no_reply for a single-context server", async () => {
    // The assertions run inside the turn's handler; their completion or
    // failure is what the test stands on. Awaiting `runtime.start()` alone
    // would not establish that the assertion ran.
    let settle: (error?: unknown) => void;
    const outcome = new Promise<void>((resolve, reject) => {
      settle = (error) => (error === undefined ? resolve() : reject(error));
    });
    outcome.catch(() => undefined);
    await runtimeWithNetworkBackend("http", async ({ tools }) => {
      try {
        const backend = await createBandMcpBackend({
          kind: "http",
          enableMemoryTools: false, enableOperationIds: true,
          multiRoom: false,
          getToolsForRoom: () => tools,
        });
        onTestFinished(async () => {
          await backend.stop();
        });
        const client = await connectClient(backend, "no-reply-single");
        try {
          const listed = await client.listTools();
          const noReply = listed.tools.find((tool) => tool.name === "band_no_reply");
          const schema = noReply?.inputSchema as { properties?: Record<string, unknown> } | undefined;
          expect(schema?.properties, "a roomless server advertises no room_id").not.toHaveProperty("room_id");
          settle();
        } finally {
          await client.close().catch(() => undefined);
        }
      } catch (error) {
        settle(error);
      }
    });
    await outcome;
  }, 90000);
});

describe("the contact callback consumer", () => {
  it("refuses a keyed send without any post or durable credit", async () => {
    let posts = 0;
    const rest = new FakeRestApi({
      createChatMessage: async () => {
        posts += 1;
        return { id: "contact-post" };
      },
    });
    const tools = new ContactCallbackTools(rest as never, "contact-room");
    const refused = await tools
      .sendMessage("must refuse without durable context", [{ id: OWNER }], { operationId: "contact-key" })
      .catch((error) => error);
    expect(posts).toBe(0);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toBeTruthy();
  });

  it("refuses a keyed no-request without any post", async () => {
    let posts = 0;
    const rest = new FakeRestApi({
      createChatMessage: async () => {
        posts += 1;
        return { id: "contact-post" };
      },
    });
    const tools = new ContactCallbackTools(rest as never, "contact-room");
    const refused = await tools
      .executeToolCall("band_no_reply", { reason: "fyi only", operation_id: "contact-decline" })
      .catch((error) => error);
    expect(posts).toBe(0);
    const result = refused as { ok?: boolean; message?: string } | undefined;
    expect(result && (result.ok === false || typeof result.message === "string")).toBe(true);
  });
});