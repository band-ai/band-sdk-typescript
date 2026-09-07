import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPrincipalRealtimeConnection } from "@band-ai/sdk/realtime";
import { ValidationError } from "../src/core/errors";

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ROOM_ID = "room-1";

const phoenixMock = vi.hoisted(() => {
  type Outcome = "ok" | "error" | "timeout" | "pending";
  class FakeChannel {
    public readonly topic: string;
    public joinOutcome: Outcome = "ok";
    public leaveOutcome: Outcome = "ok";
    public joinPayload: unknown = { working_agents: [] };
    public readonly handlers = new Map<
      string,
      (payload: Record<string, unknown>) => void
    >();
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
    public join() {
      return this.receiver(this.joinOutcome, this.joinPayload);
    }
    public leave() {
      return this.receiver(this.leaveOutcome, {});
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
  class FakeSocket {
    public static readonly instances: FakeSocket[] = [];
    public readonly channels: FakeChannel[] = [];
    public reconnectTimer = { reset(): void {}, scheduleTimeout(): void {} };
    private nextRef = 0;
    private openHandler: (() => void) | null = null;
    public constructor(_url: string, _options: { params: Record<string, unknown> }) {
      FakeSocket.instances.push(this);
    }
    public makeRef(): string {
      this.nextRef += 1;
      return String(this.nextRef);
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
      const channel = new FakeChannel(topic);
      this.channels.push(channel);
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
    activityJoinOutcome: "ok" as Outcome,
    reset() {
      this.activityJoinOutcome = "ok";
      FakeSocket.instances.splice(0, FakeSocket.instances.length);
    },
  };
});

vi.mock("phoenix", () => ({
  Channel: phoenixMock.FakeChannel,
  Socket: phoenixMock.FakeSocket,
}));

describe("principal realtime held regressions", () => {
  beforeEach(() => phoenixMock.reset());

  it("rejects whitespace, oversized IDs, and invalid conflict policy", () => {
    expect(() =>
      createPrincipalRealtimeConnection({
        principal: { kind: "human", userId: "   ", apiKey: "k" },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      createPrincipalRealtimeConnection({
        principal: { kind: "human", userId: "x".repeat(300), apiKey: "k" },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      createPrincipalRealtimeConnection({
        principal: {
          kind: "agent",
          agentId: AGENT_ID,
          apiKey: "k",
          conflictPolicy: "nope" as never,
        },
      }),
    ).toThrow(ValidationError);
  });

  it("aborts an in-flight join and does not install after dispose", async () => {
    phoenixMock.activityJoinOutcome = "pending";
    const connection = createPrincipalRealtimeConnection({
      principal: { kind: "human", userId: "user-1", apiKey: "human-key" },
    });
    connection.subscribe(() => undefined);
    await connection.setSelectedRoom(ROOM_ID);
    const start = connection.start();
    await vi.waitFor(() => {
      expect(phoenixMock.FakeSocket.instances.at(-1)?.channels.length).toBeGreaterThan(0);
    });
    await connection.dispose();
    await expect(start).rejects.toBeTruthy();
    expect(phoenixMock.FakeSocket.instances.at(-1)?.channels).toHaveLength(0);
  });

  it("does not log raw payloads on observer failure", async () => {
    const error = vi.fn();
    const connection = createPrincipalRealtimeConnection({
      principal: { kind: "agent", agentId: AGENT_ID, apiKey: "agent-key" },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error },
    });
    connection.subscribe(() => {
      throw new Error("secret-token-value");
    });
    await connection.start();
    expect(error).toHaveBeenCalledWith(
      "Realtime observer failed",
      expect.objectContaining({ code: "observer.error" }),
    );
    const serialized = JSON.stringify(error.mock.calls);
    expect(serialized).not.toContain("secret-token-value");
    await connection.dispose();
  });
});
