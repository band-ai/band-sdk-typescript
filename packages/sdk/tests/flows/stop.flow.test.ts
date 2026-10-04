/**
 * Stopping a runtime whose rooms are still joining, through the real platform
 * runtime: rooms already joined stop at their turn in flight on the stop's
 * terms, and what they hadn't started waits for the next start.
 */
import { describe, expect, it } from "vitest";

import type { FrameworkAdapter, FrameworkAdapterInput } from "../../src/contracts/protocols";
import { PlatformRuntime } from "../../src/runtime";
import { RecordLog } from "../testUtils";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./support/bandPlatform";

const USER = "user-1";
const MENTION = `@[[${AGENT_ID}]]`;
const STOP_AT_TURN_IN_FLIGHT_MS = 0;

/** Records every message it is handed. */
class RecordingAdapter implements FrameworkAdapter {
  public readonly handled = new RecordLog<string>();

  public async onStarted(): Promise<void> {}

  public async onEvent({ message }: FrameworkAdapterInput): Promise<void> {
    this.handled.record(message.id);
  }

  public async onCleanup(): Promise<void> {}
}

function runtimeOn(platform: BandPlatform): PlatformRuntime {
  return new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    linkOptions: platform.link,
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

describe("stopping while the agent's rooms are still joining", () => {
  it("stops a joined room at its turn in flight and leaves the rest for the next start", async () => {
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room("room-1");
    const inFlight = room.postBeforeConnect(USER, `${MENTION} one`);
    const waiting = room.postBeforeConnect(USER, `${MENTION} two`);
    const releaseLaterRoom = (await platform.room("room-2")).holdJoin();
    const held = room.holdProcessing(inFlight);
    const first = new RecordingAdapter();
    const runtime = runtimeOn(platform);
    const starting = runtime.start(first).catch(() => undefined);
    await held.sending;

    const stopping = runtime.stop(STOP_AT_TURN_IN_FLIGHT_MS);
    held.release();
    expect(await room.outcome(inFlight)).toBe("processed");
    // Arrives while the stop waits on the start: the runtime must not take it up.
    await room.say(USER, `${MENTION} three`);
    releaseLaterRoom();
    await Promise.all([starting, stopping]);

    const next = new RecordingAdapter();
    await using _next = runtimeOn(platform);
    await _next.start(next);
    expect(await room.outcome(waiting)).toBe("processed");
    expect(first.handled.entries).toEqual([inFlight]);
  });
});
