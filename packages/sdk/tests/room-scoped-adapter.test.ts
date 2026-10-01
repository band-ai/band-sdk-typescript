import path from "node:path";

import { describe, expect, it } from "vitest";

import type { PlatformMessageLike } from "../src/contracts/protocols";
import { createDeferred } from "../src/core/deferred";
import { SimpleAdapter } from "../src/core/simpleAdapter";
import { RoomScopedAdapter, type RoomScopedAdapterOptions } from "../src/adapters/shared/roomScopedAdapter";
import { FakeTools, expectTurnFailed, findFailureEvent, makeMessage, roomWorkspacePath, tmpRoot } from "./testUtils";

interface RoomHooks {
  start?(room: RecordingRoom): Promise<void>;
  stop?(room: RecordingRoom): Promise<void>;
}

/** A room engine that records what the router asked of it. */
class RecordingRoom extends SimpleAdapter<unknown, FakeTools> {
  protected readonly provider = "test";
  public readonly messages: string[] = [];
  public readonly cleanedUp: string[] = [];
  public started = 0;
  public stopped = 0;

  public constructor(public readonly roomId: string, public readonly workspace: string, private readonly hooks: RoomHooks) {
    super();
  }

  public override async onStarted(agentName: string, agentDescription: string): Promise<void> {
    await super.onStarted(agentName, agentDescription);
    await this.hooks.start?.(this);
    this.started++;
  }

  public async onMessage(message: PlatformMessageLike): Promise<void> {
    this.messages.push(message.content);
  }

  public override async onCleanup(roomId: string): Promise<void> {
    this.cleanedUp.push(roomId);
  }

  public async onRuntimeStop(): Promise<void> {
    await this.hooks.stop?.(this);
    this.stopped++;
  }
}

class RecordingRouter extends RoomScopedAdapter<unknown, FakeTools, RecordingRoom> {
  protected readonly provider = "test";
  public readonly created: RecordingRoom[] = [];

  public constructor(options: RoomScopedAdapterOptions<unknown>, private readonly hooks: RoomHooks = {}) {
    super(options);
  }

  protected createRoom(roomId: string, workspace: string): RecordingRoom {
    const room = new RecordingRoom(roomId, workspace, this.hooks);
    this.created.push(room);
    return room;
  }

  public roomsFor(roomId: string): RecordingRoom[] {
    return this.created.filter((room) => room.roomId === roomId);
  }
}

function send(router: RecordingRouter, roomId: string, content = "hi", tools = new FakeTools()): Promise<void> {
  return router.onMessage(makeMessage(content, roomId), tools, null, null, null, { isSessionBootstrap: false, roomId });
}

async function startedRouter(options: RoomScopedAdapterOptions<unknown> = { cwd: tmpRoot() }, hooks?: RoomHooks) {
  const router = new RecordingRouter(options, hooks);
  await router.onStarted("Agent", "desc");
  return router;
}

describe("RoomScopedAdapter", () => {
  it("starts nothing until a room's first message, then gives that room its own engine and workspace", async () => {
    const root = tmpRoot();
    const router = await startedRouter({ cwd: root });
    expect(router.created).toEqual([]);

    await send(router, "room-a", "one");
    await send(router, "room-b", "two");
    await send(router, "room-a", "three");

    const [roomA, roomB] = router.created;
    expect(router.created).toHaveLength(2);
    expect(roomA).toMatchObject({ workspace: roomWorkspacePath(root, "room-a"), messages: ["one", "three"], started: 1 });
    expect(roomB).toMatchObject({ workspace: roomWorkspacePath(root, "room-b"), messages: ["two"], started: 1 });
  });

  it("builds one engine when a room's first two messages arrive together", async () => {
    const router = await startedRouter();

    await Promise.all([send(router, "room-1", "one"), send(router, "room-1", "two")]);

    expect(router.created).toHaveLength(1);
    expect(router.created[0]!.messages).toEqual(["one", "two"]);
  });

  it("stops only the leaving room's engine", async () => {
    const router = await startedRouter();
    await send(router, "room-a");
    await send(router, "room-b");
    const [roomA, roomB] = router.created;

    await router.onCleanup("room-a");
    await router.onCleanup("room-unknown");

    await expect.poll(() => roomA!.stopped).toBe(1);
    expect(roomA!.cleanedUp).toEqual(["room-a"]);
    expect(roomB).toMatchObject({ stopped: 0, cleanedUp: [] });
  });

  it("starts a rejoining room only after its old engine has stopped, on the same workspace", async () => {
    const stopping = createDeferred();
    const router = await startedRouter({ cwd: tmpRoot() }, {
      stop: (room) => (room === router.created[0] ? stopping.promise : Promise.resolve()),
    });
    await send(router, "room-1", "before");
    const [old] = router.created;

    await router.onCleanup("room-1");
    const rejoined = send(router, "room-1", "after");
    await expect.poll(() => router.created.length).toBe(2);
    const fresh = router.created[1]!;
    expect(fresh.started).toBe(0);

    stopping.resolve();
    await rejoined;

    expect(old!.stopped).toBe(1);
    expect(fresh).toMatchObject({ workspace: old!.workspace, started: 1, messages: ["after"] });
  });

  it("reports a workspace conflict in the room and keeps serving other rooms", async () => {
    const root = tmpRoot();
    const router = await startedRouter({
      workspaceForRoom: (roomId) => path.join(root, roomId === "room-c" ? "other" : "shared"),
    });
    await send(router, "room-a");

    const tools = new FakeTools();
    await expectTurnFailed(send(router, "room-b", "hi", tools));
    await send(router, "room-c");

    expect(findFailureEvent(tools)?.content).toContain("already in use by room room-a");
    expect(router.created.map((room) => room.roomId)).toEqual(["room-a", "room-c"]);
  });

  it("drops a room whose engine failed to start, so its next message tries again", async () => {
    let failures = 1;
    const router = await startedRouter({ cwd: tmpRoot() }, {
      start: async () => {
        if (failures-- > 0) {
          throw new Error("agent would not start");
        }
      },
    });

    const tools = new FakeTools();
    await expectTurnFailed(send(router, "room-1", "first", tools));
    await send(router, "room-1", "second");

    expect(findFailureEvent(tools)?.content).toContain("agent would not start");
    expect(router.created).toHaveLength(2);
    expect(router.created[1]!.messages).toEqual(["second"]);
  });

  it("reports a message that arrives after stop instead of starting an engine for it", async () => {
    const router = await startedRouter();
    await router.stop();

    const tools = new FakeTools();
    await expectTurnFailed(send(router, "room-1", "hi", tools));

    expect(findFailureEvent(tools)?.content).toContain("Adapter is stopped");
    expect(router.created).toEqual([]);
  });

  it("serves rooms again once restarted after stop", async () => {
    const router = await startedRouter();
    await router.stop();
    await router.onStarted("Agent", "desc");

    await send(router, "room-1");

    expect(router.created).toHaveLength(1);
  });

  it("stops every engine at once and finishes even when one fails to stop", async () => {
    const release = createDeferred();
    let stopping = 0;
    const router = await startedRouter({ cwd: tmpRoot() }, {
      stop: async (room) => {
        stopping++;
        if (room.roomId === "room-a") {
          throw new Error("would not stop");
        }
        await release.promise;
      },
    });
    for (const roomId of ["room-a", "room-b", "room-c"]) {
      await send(router, roomId);
    }

    const stopped = router.onRuntimeStop();
    // Every engine is asked to stop before any of them has finished.
    await expect.poll(() => stopping).toBe(3);
    release.resolve();
    await stopped;

    expect(router.created.map((room) => room.stopped)).toEqual([0, 1, 1]);
  });
});
