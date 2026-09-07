import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPrincipalRealtimeConnection } from "@band-ai/sdk/realtime";
import { ValidationError } from "../src/core/errors";

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const EXEC_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PARTICIPANT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ROOM_ID = "room-1";

const phoenixMock = vi.hoisted(() => {
  type Outcome = "ok" | "error" | "timeout" | "pending";

  class FakeChannel {
    public readonly topic: string;
    public readonly handlers = new Map<
      string,
      (payload: Record<string, unknown>) => void
    >();
    public joinOutcome: Outcome = "ok";
    public leaveOutcome: Outcome = "ok";
    public joinPayload: unknown = { working_agents: [] };
    private nextRef = 1;

    public constructor(topic: string) {
      this.topic = topic;
    }

    public on(
      event: string,
      handler: (payload: Record<string, unknown>) => void,
    ): number {
      this.handlers.set(event, handler);
      return this.nextRef++;
    }

    public off(_event: string, _ref?: number): void {}

    public emit(event: string, payload: Record<string, unknown>): void {
      this.handlers.get(event)?.(payload);
    }

    public join(): {
      receive: (kind: Outcome, callback: (payload?: unknown) => void) => unknown;
    } {
      return this.receiver(this.joinOutcome, this.joinPayload);
    }

    public leave(): {
      receive: (kind: Outcome, callback: (payload?: unknown) => void) => unknown;
    } {
      return this.receiver(this.leaveOutcome, {});
    }

    private receiver(outcome: Outcome, payload: unknown): {
      receive: (kind: Outcome, callback: (payload?: unknown) => void) => unknown;
    } {
      const chain = {
        receive: (kind: Outcome, callback: (payload?: unknown) => void) => {
          if (kind === outcome && kind !== "pending") {
            queueMicrotask(() =>
              callback(kind === "ok" ? payload : { error: kind }),
            );
          }
          return chain;
        },
      };
      return chain;
    }
  }

  class FakeChannelList extends Array<FakeChannel> {
    public get(topic: string): FakeChannel | undefined {
      return this.find((channel) => channel.topic === topic);
    }
  }

  class FakeSocket {
    public static readonly instances: FakeSocket[] = [];
    public readonly url: string;
    public readonly params: Record<string, unknown>;
    public readonly channels = new FakeChannelList();
    private openHandler: (() => void) | null = null;

    public constructor(
      url: string,
      options: { params: Record<string, unknown> },
    ) {
      this.url = url;
      this.params = options.params;
      FakeSocket.instances.push(this);
    }

    public onOpen(handler: () => void): void {
      this.openHandler = handler;
    }
    public onClose(): void {}
    public onError(): void {}
    public connect(): void {
      queueMicrotask(() => this.openHandler?.());
    }
    public disconnect(): void {}
    public channel(topic: string): FakeChannel {
      const existing = this.channels.get(topic);
      if (existing) {
        return existing;
      }
      const channel = new FakeChannel(topic);
      if (topic.startsWith("room_activity:") && phoenixMock.activityJoinPayload) {
        channel.joinPayload = phoenixMock.activityJoinPayload;
      }
      this.channels.push(channel);
      return channel;
    }
    public remove(channel: FakeChannel): void {
      const index = this.channels.indexOf(channel);
      if (index >= 0) {
        this.channels.splice(index, 1);
      }
    }
  }

  return {
    FakeChannel,
    FakeSocket,
    activityJoinPayload: {
      working_agents: [
        { agent_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", execution_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", working: true },
      ],
    } as unknown,
    reset: () => {
      FakeSocket.instances.splice(0, FakeSocket.instances.length);
    },
  };
});

vi.mock("phoenix", () => ({
  Channel: phoenixMock.FakeChannel,
  Socket: phoenixMock.FakeSocket,
}));

function latestSocket() {
  const socket = phoenixMock.FakeSocket.instances.at(-1);
  if (!socket) {
    throw new Error("expected phoenix socket");
  }
  return socket;
}

function chatPayload(roomId = ROOM_ID): Record<string, unknown> {
  return {
    id: "m1",
    content: "hello",
    message_type: "text",
    sender_id: "u1",
    sender_type: "User",
    chat_room_id: roomId,
    inserted_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

async function startHuman(selectedRoom?: string | null) {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const connection = createPrincipalRealtimeConnection({
    principal: { kind: "human", userId: "user-1", apiKey: "human-key" },
  });
  connection.subscribe((event) => {
    events.push(event);
  });
  if (selectedRoom !== undefined) {
    await connection.setSelectedRoom(selectedRoom);
  }
  await connection.start();
  return { connection, events, socket: latestSocket() };
}

describe("principal realtime", () => {
  beforeEach(() => {
    phoenixMock.activityJoinPayload = {
      working_agents: [
        { agent_id: AGENT_ID, execution_id: EXEC_ID, working: true },
      ],
    };
    phoenixMock.reset();
  });

  it("opens a human socket without agent_id and emits mapping rows", async () => {
    const { connection, events, socket } = await startHuman(ROOM_ID);

    expect(socket.params.agent_id).toBeUndefined();
    expect(socket.params.on_conflict).toBeUndefined();
    expect(events.filter((event) => event.type === "connection").map((event) => event.state)).toEqual([
      "connecting",
      "ready",
    ]);
    expect(events).toContainEqual({
      type: "room_activity",
      roomId: ROOM_ID,
      state: "ready",
      snapshot: [{ agentId: AGENT_ID, executionId: EXEC_ID }],
    });

    const userAgents = socket.channels.get("user_agents:user-1");
    userAgents?.emit("agent_created", { ignored: true });
    userAgents?.emit("agent_updated", { ignored: true });
    userAgents?.emit("agent_deleted", { ignored: true });

    const chat = socket.channels.get(`chat_room:${ROOM_ID}`);
    chat?.emit("message_created", chatPayload());
    chat?.emit("message_updated", chatPayload());
    chat?.emit("event_created", chatPayload());
    chat?.emit("message_deleted", { id: "m1", chat_room_id: ROOM_ID });

    const participants = socket.channels.get(`room_participants:${ROOM_ID}`);
    participants?.emit("participant_added", {
      id: PARTICIPANT_ID,
      name: "Agent",
      type: "agent",
    });
    participants?.emit("participant_removed", { id: PARTICIPANT_ID });
    participants?.emit("agent_connected", {
      id: PARTICIPANT_ID,
      chat_room_id: ROOM_ID,
      connected: true,
    });
    participants?.emit("agent_disconnected", {
      id: PARTICIPANT_ID,
      chat_room_id: ROOM_ID,
      connected: false,
    });
    participants?.emit("room_title_changed", {
      id: ROOM_ID,
      title: "New title",
    });

    const activity = socket.channels.get(`room_activity:${ROOM_ID}`);
    const nextExec = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    activity?.emit("agent_activity_started", {
      agent_id: AGENT_ID,
      execution_id: nextExec,
      working: true,
    });
    activity?.emit("agent_activity_stopped", {
      agent_id: AGENT_ID,
      execution_id: nextExec,
      working: false,
    });

    participants?.emit("room_deleted", { id: ROOM_ID });

    expect(events.filter((event) => event.type === "user_agents_changed")).toHaveLength(3);
    expect(
      events.filter((event) => event.type === "chat_changed").map((event) => event.kind),
    ).toEqual([
      "message_created",
      "message_updated",
      "event_created",
      "message_deleted",
    ]);
    expect(
      events
        .filter((event) => event.type === "participants_changed")
        .map((event) => event.kind),
    ).toEqual(["added", "removed", "presence_changed", "presence_changed"]);
    expect(events).toContainEqual({ type: "room_title_changed", roomId: ROOM_ID });
    expect(events).toContainEqual({ type: "room_deleted", roomId: ROOM_ID });
    expect(events).toContainEqual({
      type: "room_activity",
      roomId: ROOM_ID,
      state: "unavailable",
    });

    await connection.dispose();
  });

  it("rejects malformed, wrong-topic, and stale-room events", async () => {
    const { connection, events, socket } = await startHuman(ROOM_ID);
    const before = events.length;
    socket.channels.get(`chat_room:${ROOM_ID}`)?.emit("message_created", {
      id: "bad",
    });
    socket.channels.get(`chat_room:${ROOM_ID}`)?.emit("message_created", {
      ...chatPayload("other-room"),
    });
    socket.channels
      .get(`room_participants:${ROOM_ID}`)
      ?.emit("room_title_changed", { id: ROOM_ID, title: "" });
    socket.channels.get(`room_activity:${ROOM_ID}`)?.emit("agent_activity_started", {
      agent_id: "not-a-uuid",
      execution_id: EXEC_ID,
      working: true,
    });

    expect(events.length).toBe(before);
    await connection.setSelectedRoom("room-2");
    const afterSwitch = events.length;
    socket.channels.get(`chat_room:${ROOM_ID}`)?.emit("message_created", chatPayload());
    expect(events.length).toBe(afterSwitch);
    await connection.dispose();
  });

  it("marks overflow and duplicate snapshots unavailable", async () => {
    const connection = createPrincipalRealtimeConnection({
      principal: { kind: "human", userId: "user-1", apiKey: "human-key" },
    });
    const events: Array<{ type: string; state?: string }> = [];
    connection.subscribe((event) => events.push(event));
    await connection.setSelectedRoom(ROOM_ID);
    phoenixMock.activityJoinPayload = {
      working_agents: [
        { agent_id: AGENT_ID, execution_id: EXEC_ID, working: true },
        { agent_id: AGENT_ID, execution_id: EXEC_ID, working: true },
      ],
    };
    await connection.start();
    expect(events).toContainEqual({
      type: "room_activity",
      roomId: ROOM_ID,
      state: "unavailable",
    });
    await connection.dispose();
  });

  it("joins only agent_control for an agent principal", async () => {
    const events: Array<{ type: string }> = [];
    const connection = createPrincipalRealtimeConnection({
      principal: {
        kind: "agent",
        agentId: AGENT_ID,
        apiKey: "agent-key",
        conflictPolicy: "supersede",
      },
    });
    connection.subscribe((event) => events.push(event));
    await connection.start();
    const socket = latestSocket();
    expect(socket.params.agent_id).toBe(AGENT_ID);
    expect(socket.params.on_conflict).toBe("supersede");
    expect(socket.channels.map((channel) => channel.topic)).toEqual([
      `agent_control:${AGENT_ID}`,
    ]);
    await expect(connection.setSelectedRoom(ROOM_ID)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(() =>
      createPrincipalRealtimeConnection({
        principal: {
          kind: "human",
          userId: "user-1",
          apiKey: "human-key",
          conflictPolicy: "supersede",
        } as never,
      }),
    ).toThrow(ValidationError);
    await connection.dispose();
    await connection.dispose();
  });

  it("fails closed when aborted before start", async () => {
    const abort = new AbortController();
    abort.abort();
    const connection = createPrincipalRealtimeConnection({
      principal: { kind: "human", userId: "user-1", apiKey: "human-key" },
      abortSignal: abort.signal,
    });
    connection.subscribe(() => undefined);
    await expect(connection.start()).rejects.toThrow(/aborted/);
    await connection.dispose();
  });

  it("rejects a second observer and ignores events after dispose", async () => {
    const { connection, events, socket } = await startHuman();
    expect(() => connection.subscribe(() => undefined)).toThrow(ValidationError);
    await connection.dispose();
    const before = events.length;
    socket.channels.get("user_agents:user-1")?.emit("agent_created", {});
    expect(events.length).toBe(before);
  });
});
