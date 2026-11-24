
import { describe, expect, it, onTestFinished } from "vitest";

import { GenericAdapter, type GenericAdapterHandler } from "../src/adapters/GenericAdapter";
import { createDeferred } from "../src/core/deferred";
import { relayReply, type TurnTools } from "../src/core/turn";
import { KEYED_ADMISSION_REFUSALS } from "../src/mcp/admission";
import { ContactCallbackTools } from "../src/runtime/tools/ContactCallbackTools";
import { PlatformRuntime } from "../src/runtime";
import type { SessionConfig } from "../src/runtime/types";
import { FakeRestApi, tmpRoot } from "./testUtils";
import { IDENTITY, recordTypes, roomFile } from "./turnJournalSupport";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person, type BandRoom } from "./flows/support/bandPlatform";
import { BRIDGE_KINDS, openBridge } from "./support/mcpBridges";

const OWNER = "owner";
const MENTION = `@[[${AGENT_ID}]]`;
const KILL = 0;

/**
 * Starts a runtime whose rooms each hold an inbound turn message, so a turn runs
 * per room the moment the runtime connects. The handler receives each turn's live
 * tools and room.
 */
async function runtimeWithInbounds(
  handler: GenericAdapterHandler,
  options: { rooms?: string[] } = {},
) {
  const rooms = options.rooms ?? ["room-1"];
  const platform = BandPlatform.host([person(OWNER)]);
  /** Each room's inbound turn message, by room. */
  const inbounds = new Map<string, { room: BandRoom; messageId: string }>();
  for (const roomId of rooms) {
    const room = await platform.room(roomId);
    inbounds.set(roomId, { room, messageId: room.postBeforeConnect(OWNER, `${MENTION} review ${roomId}`) });
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
  return { platform, runtime, journalDir, inbounds };
}

const postedContents = (platform: BandPlatform, roomId?: string) =>
  platform.rest.posted.entries
    .filter(({ messageType }) => messageType !== "error")
    .filter((entry) => roomId === undefined || entry.roomId === roomId)
    .map(({ content }) => content);

const textOf = (result: object) => ((result as { content?: unknown }).content as Array<{ text: string }> | undefined)?.[0]?.text ?? "";

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
            const client = await openBridge(kind, {
              enableOperationIds: true,
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
            switchAfterAdmission = true;
            const result = await client.callTool({
              name: "band_send_message",
              arguments: { content: "must stay with original tools", mentions: [OWNER], operation_id: `origin-${kind}-key` },
            });
            observed.resolve(result.isError ? new Error(`the keyed call was refused: ${textOf(result)}`) : undefined);
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
      await platform.rest.posted.until(() => postedContents(platform).includes("must stay with original tools"));
      expect(postedContents(platform, "origin-room")).toEqual(["must stay with original tools"]);
      expect(postedContents(platform, "successor-room")).toEqual([]);
    }, 90000);

    it(`refuses a keyed call whose admission guard stands retired: no post, no re-resolution, and the turn's reply still stands`, async () => {
      let retiredError: boolean | undefined;
      let retiredText = "";
      let relayed: boolean | undefined;
      let resolutions = 0;
      const done = createDeferred<void>();
      const { platform } = await runtimeWithInbounds(async ({ tools }) => {
        let live = true;
        const client = await openBridge(kind, {
          enableOperationIds: true,
          getToolsForRoom: () => {
            resolutions += 1;
            return tools;
          },
          admissionGuard: () => live,
        });
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
          done.resolve();
        }
      });
      await done.promise;
      // The refused call stands with a clean text: no post, no re-resolution. A
      // generation that retired before the call admits no origin and fences no turn.
      expect(retiredError).toBe(true);
      expect(retiredText).toBe(KEYED_ADMISSION_REFUSALS.noOrigin);
      expect(resolutions).toBe(0);
      expect(relayed).toBe(true);
      expect(postedContents(platform)).toEqual(["closing reply stands"]);
    }, 90000);
  });
}

describe("room-scoped no-reply over the wire", () => {
  it("advertises room_id on band_no_reply, and a keyed decline for the selected room settles that room's turn under the key", async () => {
    const successorReady = createDeferred<TurnTools>();
    const releaseSuccessor = createDeferred<void>();
    const successorRelayed = createDeferred<boolean>();
    const observed = Promise.withResolvers<{ declineError?: boolean; relayed: boolean }>();
    // Awaited below; a rejection before then must not count as unhandled.
    observed.promise.catch(() => undefined);
    onTestFinished(async () => {
      releaseSuccessor.resolve();
    });
    const { platform, journalDir, inbounds } = await runtimeWithInbounds(async ({ tools, roomId }) => {
      if (roomId === "room-2") {
        // The selected room's turn stands live, so its tools resolve, until the
        // caller's decline settled it; its own closing text then meets the fence.
        successorReady.resolve(tools);
        await releaseSuccessor.promise;
        successorRelayed.resolve(await relayReply(tools, "room-2 closing text", [OWNER]));
        return;
      }
      const otherTools = await successorReady.promise;
      const client = await openBridge("http", {
        enableOperationIds: true,
        getToolsForRoom: (otherRoomId: string) =>
          otherRoomId === "room-1" ? tools : otherRoomId === "room-2" ? otherTools : undefined,
      });
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
      } catch (error) {
        // A failed assertion in the handler fails the test rather than leave it waiting.
        observed.reject(error);
      } finally {
        await client.close();
        releaseSuccessor.resolve();
      }
    }, { rooms: ["room-1", "room-2"] });
    const outcome = await observed.promise;
    expect(outcome.declineError).toBe(false);
    // The decline stood in the selected room: its turn's closing text is fenced
    // and nothing posts there, and its inbound settles processed under the key.
    expect(await successorRelayed.promise).toBe(false);
    const selected = inbounds.get("room-2")!;
    expect(await selected.room.outcome(selected.messageId)).toBe("processed");
    expect(postedContents(platform, "room-2")).toEqual([]);
    // The caller's room is unaffected: its closing text stands.
    expect(outcome.relayed).toBe(true);
    expect(postedContents(platform, "room-1")).toEqual(["own closing text"]);
    const records = await recordTypes(roomFile(journalDir, IDENTITY, AGENT_ID, "room-2"));
    expect(records).toEqual(expect.arrayContaining(["op.reserved", "op.settled", "decline.settled", "turn.done"]));
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
    await runtimeWithInbounds(async ({ tools }) => {
      try {
        const client = await openBridge("http", { enableOperationIds: true, multiRoom: false, getToolsForRoom: () => tools });
        try {
          const listed = await client.listTools();
          const noReply = listed.tools.find((tool) => tool.name === "band_no_reply");
          const schema = noReply?.inputSchema as { properties?: Record<string, unknown> } | undefined;
          expect(schema?.properties, "a roomless server advertises no room_id").not.toHaveProperty("room_id");
          settle();
        } finally {
          await client.close();
        }
      } catch (error) {
        settle(error);
      }
    });
    await outcome;
  }, 90000);
});

describe("every bridge's keyed admission", () => {
  for (const kind of BRIDGE_KINDS) {
    for (const multiRoom of [true, false]) {
      const scope = multiRoom ? "room-scoped" : "single-context";
      it(`${kind} (${scope}) posts a keyed send once, replays its retry, and fences the turn's closing relay`, async () => {
        const outcome = createDeferred<{ first: string; retry: string; relayed: boolean } | { error: unknown }>();
        const { platform, journalDir } = await runtimeWithInbounds(async ({ tools }) => {
          try {
            const client = await openBridge(kind, { enableOperationIds: true, multiRoom, getToolsForRoom: () => tools });
            try {
              const arguments_ = { ...(multiRoom ? { room_id: "room-1" } : {}), content: "keyed once", mentions: [OWNER], operation_id: `${kind}-${scope}` };
              const first = await client.callTool({ name: "band_send_message", arguments: arguments_ });
              const retry = await client.callTool({ name: "band_send_message", arguments: arguments_ });
              const relayed = await relayReply(tools, "closing text", [OWNER]);
              outcome.resolve({ first: textOf(first), retry: textOf(retry), relayed });
            } finally {
              await client.close();
            }
          } catch (error) {
            outcome.resolve({ error });
          }
        });
        const result = await outcome.promise;
        if ("error" in result) throw result.error;
        expect(JSON.parse(result.first)).toEqual({ id: "posted-1" });
        expect(result.retry).toBe(result.first);
        expect(result.relayed).toBe(false);
        expect(postedContents(platform)).toEqual(["keyed once"]);
        expect(await recordTypes(roomFile(journalDir, IDENTITY, AGENT_ID, "room-1"))).toContain("op.settled");
      }, 90000);
    }

    it(`${kind} without enableOperationIds refuses a keyed send or no-reply rather than run it unkeyed, and leaves the turn unfenced`, async () => {
      type Refusal = { isError: boolean; text: string };
      const outcome = createDeferred<{ send: Refusal; decline: Refusal; relayed: boolean } | { error: unknown }>();
      const { platform, journalDir } = await runtimeWithInbounds(async ({ tools }) => {
        try {
          const client = await openBridge(kind, { getToolsForRoom: () => tools });
          const refusal = (result: object): Refusal => ({ isError: Boolean((result as { isError?: unknown }).isError), text: textOf(result) });
          try {
            const send = await client.callTool({
              name: "band_send_message",
              arguments: { room_id: "room-1", content: "status update", mentions: [OWNER], operation_id: "same-key" },
            });
            const decline = await client.callTool({
              name: "band_no_reply",
              arguments: { room_id: "room-1", reason: "fyi only", operation_id: "decline-key" },
            });
            const relayed = await relayReply(tools, "closing text", [OWNER]);
            outcome.resolve({ send: refusal(send), decline: refusal(decline), relayed });
          } finally {
            await client.close();
          }
        } catch (error) {
          outcome.resolve({ error });
        }
      });
      const result = await outcome.promise;
      if ("error" in result) throw result.error;
      const notServed = { isError: true, text: KEYED_ADMISSION_REFUSALS.notServed };
      expect(result.send).toEqual(notServed);
      expect(result.decline).toEqual(notServed);
      // Nothing keyed ran: the turn's own closing text stands, and no operation is recorded.
      expect(result.relayed).toBe(true);
      expect(postedContents(platform)).toEqual(["closing text"]);
      const records = await recordTypes(roomFile(journalDir, IDENTITY, AGENT_ID, "room-1"));
      expect(records.filter((record) => record.startsWith("op."))).toEqual([]);
    }, 90000);
  }

  it("admits a keyed call whose room_id carries the padding an unkeyed call tolerates", async () => {
    const outcome = createDeferred<{ keyed: boolean; unkeyed: boolean } | { error: unknown }>();
    const { platform } = await runtimeWithInbounds(async ({ tools }) => {
      try {
        const client = await openBridge("http", { enableOperationIds: true, getToolsForRoom: (id) => (id === "room-1" ? tools : undefined) });
        try {
          const keyed = await client.callTool({ name: "band_send_message", arguments: { room_id: " room-1 ", content: "keyed", mentions: [OWNER], operation_id: "padded" } });
          const unkeyed = await client.callTool({ name: "band_send_message", arguments: { room_id: " room-1 ", content: "unkeyed", mentions: [OWNER] } });
          outcome.resolve({ keyed: Boolean(keyed.isError), unkeyed: Boolean(unkeyed.isError) });
        } finally {
          await client.close();
        }
      } catch (error) {
        outcome.resolve({ error });
      }
    });
    const result = await outcome.promise;
    if ("error" in result) throw result.error;
    expect(result).toEqual({ keyed: false, unkeyed: false });
    expect(postedContents(platform, "room-1")).toEqual(["keyed", "unkeyed"]);
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
    expect(refused).toMatchObject({ name: "OperationUnsupportedError", issue: "no-journal" });
  });

  it("refuses a keyed no-reply without any post", async () => {
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
    expect(refused).toMatchObject({ name: "OperationUnsupportedError", issue: "no-journal" });
  });
});
