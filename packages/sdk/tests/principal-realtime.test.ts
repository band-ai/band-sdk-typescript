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
    public readonly handlers = new Map<string, (payload: Record<string, unknown>) => void>();
    public joinOutcome: Outcome = "ok";
    public joinPayload: unknown = { working_agents: [] };
    public constructor(topic: string) {
      this.topic = topic;
      if (topic.startsWith("room_activity:") && phoenixMock.activityJoinOutcome) {
        this.joinOutcome = phoenixMock.activityJoinOutcome;
      }
    }
    public on(event: string, handler: (payload: Record<string, unknown>) => void): number {
      this.handlers.set(event, handler);
      return 1;
    }
    public off(event: string): void {
      this.handlers.delete(event);
    }
    public emit(event: string, payload: Record<string, unknown>): void {
      this.handlers.get(event)?.(payload);
    }
    public join() {
      return this.receiver(this.joinOutcome, this.joinPayload);
    }
    public leave() {
      return this.receiver("ok", {});
    }
    private receiver(outcome: Outcome, payload: unknown) {
      const chain = {
        receive: (kind: Outcome, callback: (payload?: unknown) => void) => {
          if (kind === outcome && kind !== "pending") {
            queueMicrotask(() => callback(kind === "ok" ? payload : { error: kind }));
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
    public readonly params: Record<string, unknown>;
    public readonly channels = new FakeChannelList();
    private openHandler: (() => void) | null = null;
    private closeHandler: ((event?: { code?: number; reason?: string }) => void) | null = null;
    public reconnectTimer = { reset(): void {}, scheduleTimeout(): void {} };
    private nextRef = 0;
    public constructor(_url: string, options: { params: Record<string, unknown> }) {
      this.params = options.params;
      FakeSocket.instances.push(this);
    }
    public makeRef(): string {
      this.nextRef += 1;
      return String(this.nextRef);
    }
    public onOpen(handler: () => void): void {
      this.openHandler = handler;
    }
    public onClose(handler: (event?: { code?: number; reason?: string }) => void): void {
      this.closeHandler = handler;
    }
    public onError(): void {}
    public emitClose(event?: { code?: number; reason?: string }): void {
      this.closeHandler?.(event);
    }
    public connect(): void {
      queueMicrotask(() => this.openHandler?.());
    }
    public disconnect(): void {
      this.closeHandler?.();
    }
    public channel(topic: string): FakeChannel {
      const existing = this.channels.get(topic);
      const channel = existing ?? new FakeChannel(topic);
      if (topic.startsWith("room_activity:") && phoenixMock.activityJoinPayload) {
        channel.joinPayload = phoenixMock.activityJoinPayload;
      }
      if (!existing) this.channels.push(channel);
      return channel;
    }
    public remove(channel: FakeChannel): void {
      const index = this.channels.indexOf(channel);
      if (index >= 0) this.channels.splice(index, 1);
    }
  }
  return {
    FakeChannel,
    FakeSocket,
    activityJoinPayload: {
      working_agents: [
        {
          agent_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          execution_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          working: true,
        },
      ],
    } as unknown,
    activityJoinOutcome: "ok" as Outcome,
    resetAll() {
      this.activityJoinPayload = {
        working_agents: [
          {
            agent_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            execution_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            working: true,
          },
        ],
      };
      this.activityJoinOutcome = "ok";
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
  if (!socket) throw new Error("expected phoenix socket");
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
  if (selectedRoom !== undefined) await connection.setSelectedRoom(selectedRoom);
  await connection.start();
  return { connection, events, socket: latestSocket() };
}

describe("principal realtime", () => {
  beforeEach(() => phoenixMock.resetAll());

  it("maps human events and rejects malformed payloads", async () => {
    const { connection, events, socket } = await startHuman(ROOM_ID);
    expect(socket.params.agent_id).toBeUndefined();
    expect(events.filter((e) => e.type === "connection").map((e) => e.state)).toEqual(["connecting", "ready"]);
    socket.channels.get("user_agents:user-1")?.emit("agent_created", {});
    const chat = socket.channels.get(`chat_room:${ROOM_ID}`);
    chat?.emit("message_created", chatPayload());
    chat?.emit("event_created", {
      id: "e1",
      content: "thinking",
      message_type: "thought",
      sender_id: "u1",
      sender_type: "User",
      chat_room_id: ROOM_ID,
      inserted_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const parts = socket.channels.get(`room_participants:${ROOM_ID}`);
    parts?.emit("participant_added", { id: PARTICIPANT_ID, name: "Agent", type: "agent" });
    parts?.emit("participant_removed", { id: PARTICIPANT_ID });
    parts?.emit("agent_connected", { id: PARTICIPANT_ID, chat_room_id: ROOM_ID, connected: true });
    parts?.emit("room_title_changed", { id: ROOM_ID, title: "New title" });
    socket.channels.get(`room_activity:${ROOM_ID}`)?.emit("agent_activity_stopped", {
      agent_id: AGENT_ID,
      execution_id: EXEC_ID,
      working: false,
    });
    const before = events.length;
    chat?.emit("message_created", { id: "bad" });
    chat?.emit("event_created", { id: "e-bad" });
    expect(events.length).toBe(before);
    expect(events.filter((e) => e.type === "chat_changed").map((e) => e.kind)).toEqual(["message_created", "event_created"]);
    await connection.dispose();
  });

  it("joins only agent_control for an agent principal", async () => {
    const connection = createPrincipalRealtimeConnection({
      principal: { kind: "agent", agentId: AGENT_ID, apiKey: "agent-key", conflictPolicy: "supersede" },
    });
    connection.subscribe(() => undefined);
    await connection.start();
    expect(latestSocket().params.agent_id).toBe(AGENT_ID);
    expect(latestSocket().channels.map((c) => c.topic)).toEqual([`agent_control:${AGENT_ID}`]);
    await expect(connection.setSelectedRoom(ROOM_ID)).rejects.toBeInstanceOf(ValidationError);
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

  it("invalidates activity on close and rejoins with a fresh snapshot", async () => {
    const { connection, events, socket } = await startHuman(ROOM_ID);
    phoenixMock.activityJoinPayload = {
      working_agents: [{ agent_id: AGENT_ID, execution_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", working: true }],
    };
    socket.emitClose({ code: 1006, reason: "" });
    await vi.waitFor(() => {
      expect(connection.getState()).toBe("unavailable");
    });
    expect(events).toContainEqual({ type: "room_activity", roomId: ROOM_ID, state: "unavailable" });
    await vi.waitFor(() => {
      expect(connection.getState()).toBe("ready");
    });
    expect(events).toContainEqual({
      type: "room_activity",
      roomId: ROOM_ID,
      state: "ready",
      snapshot: [{ agentId: AGENT_ID, executionId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" }],
    });
    await connection.dispose();
  });

  it("treats overflow snapshots and a 33rd start as unavailable", async () => {
    const mk = (n: number) => ({
      agent_id: AGENT_ID,
      execution_id: `bbbbbbbb-bbbb-bbbb-bbbb-${n.toString(16).padStart(12, "0")}`,
      working: true as const,
    });
    phoenixMock.activityJoinPayload = { working_agents: Array.from({ length: 33 }, (_, i) => mk(i + 1)) };
    const first = createPrincipalRealtimeConnection({
      principal: { kind: "human", userId: "user-1", apiKey: "human-key" },
    });
    const firstEvents: Array<{ type: string; [key: string]: unknown }> = [];
    first.subscribe((event) => firstEvents.push(event));
    await first.setSelectedRoom(ROOM_ID);
    await expect(first.start()).rejects.toBeTruthy();
    expect(first.getState()).toBe("unavailable");
    expect(firstEvents.some((event) => event.type === "connection" && event.state === "ready")).toBe(false);
    await first.dispose();
    phoenixMock.resetAll();
    phoenixMock.activityJoinPayload = { working_agents: Array.from({ length: 32 }, (_, i) => mk(i + 1)) };
    const second = await startHuman(ROOM_ID);
    second.socket.channels.get(`room_activity:${ROOM_ID}`)?.emit("agent_activity_started", mk(99));
    expect(second.events).toContainEqual({ type: "room_activity", roomId: ROOM_ID, state: "unavailable" });
    await second.connection.dispose();
  });

  it("rolls back selected-room topics when activity join fails", async () => {
    phoenixMock.activityJoinOutcome = "error";
    const connection = createPrincipalRealtimeConnection({
      principal: { kind: "human", userId: "user-1", apiKey: "human-key" },
    });
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    connection.subscribe((event) => events.push(event));
    await connection.setSelectedRoom(ROOM_ID);
    await expect(connection.start()).rejects.toBeTruthy();
    expect(events).toContainEqual({ type: "room_activity", roomId: ROOM_ID, state: "unavailable" });
    await connection.dispose();
  });

  it("serializes concurrent selection and ignores events after dispose", async () => {
    const { connection, events, socket } = await startHuman(null);
    await Promise.all([connection.setSelectedRoom("room-a"), connection.setSelectedRoom("room-b")]);
    expect(events.some((event) => event.type === "room_activity" && event.roomId === "room-b" && event.state === "ready")).toBe(true);
    expect(() => connection.subscribe(() => undefined)).toThrow(ValidationError);
    await connection.dispose();
    const before = events.length;
    socket.channels.get("user_agents:user-1")?.emit("agent_created", {});
    expect(events.length).toBe(before);
  });
});
