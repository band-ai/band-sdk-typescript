/**
 * Catching up a room's backlog from `/messages/next`, through the real
 * platform runtime. Band serves the oldest message not yet processed, a
 * failed one included, and moves past a message only once it is processed
 * (docs.band.ai/integrations/custom-integration). A message runs once per
 * process, so one whose turn failed is given up by marking it processed.
 */
import { chatRoomTopic } from "@band-ai/band-sdk-core";
import { describe, expect, it } from "vitest";

import { RecoverableTurnError } from "../../src/core/errors";
import type { FrameworkAdapter, FrameworkAdapterInput } from "../../src/contracts/protocols";
import { PlatformRuntime } from "../../src/runtime";
import { createDeferred } from "../../src/core/deferred";
import { RecordLog } from "../testUtils";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./support/bandPlatform";

const USER = "user-1";
const MENTION = `@[[${AGENT_ID}]]`;

/** Records every message it is handed, failing the turns `fails` names. */
class FailingAdapter implements FrameworkAdapter {
  public readonly handled = new RecordLog<string>();

  public constructor(private readonly fails: (messageId: string) => boolean) {}

  public async onStarted(): Promise<void> {}

  public async onEvent({ message }: FrameworkAdapterInput): Promise<void> {
    this.handled.record(message.id);
    if (this.fails(message.id)) {
      throw new RecoverableTurnError(`turn for ${message.id} failed`);
    }
  }

  public async onCleanup(): Promise<void> {}
}

function runtimeOn(platform: BandPlatform, maxMessageRetries?: number): PlatformRuntime {
  return new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    linkOptions: platform.link,
    agentConfig: { autoSubscribeExistingRooms: true },
    ...(maxMessageRetries === undefined ? {} : { sessionConfig: { maxMessageRetries } }),
  });
}

describe("catching up a room from /messages/next", () => {
  it.each([undefined, 3])("gives up on a backlog message whose turn failed, so the message behind it runs (maxMessageRetries %s)", async (maxMessageRetries) => {
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room("room-1");
    const failing = room.postBeforeConnect(USER, `${MENTION} one`);
    const behind = room.postBeforeConnect(USER, `${MENTION} two`);
    const adapter = new FailingAdapter((id) => id === failing);

    await using runtime = runtimeOn(platform, maxMessageRetries);
    await runtime.start(adapter);

    expect(await room.outcome(behind)).toBe("processed");
    expect(adapter.handled.entries).toEqual([failing, behind]);
    expect(room.outcomes(failing)).toEqual(["failed", "processed"]);
  });

  it("catches up a message missed during an outage after a live turn failed", async () => {
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room("room-1");
    let failNext = true;
    const adapter = new FailingAdapter(() => {
      const fail = failNext;
      failNext = false;
      return fail;
    });
    await using runtime = runtimeOn(platform);
    await runtime.start(adapter);

    const failed = await room.say(USER, `${MENTION} live one`);
    expect(await room.outcome(failed)).toBe("failed");
    const missed = room.postBeforeConnect(USER, `${MENTION} sent while the channel was down`);
    platform.transport.triggerRejoin(chatRoomTopic("room-1"));

    expect(await room.outcome(missed)).toBe("processed");
    expect(adapter.handled.entries).toEqual([failed, missed]);
    expect(room.outcomes(failed)).toEqual(["failed", "processed"]);
  });

  it("leaves a bootstrap message's settling to its own turn when a catch-up finds it still running", async () => {
    const platform = BandPlatform.host([person(USER)]);
    const room = await platform.room("room-1");
    const running = createDeferred();
    const release = createDeferred();
    const settledBeforeItsTurnEnded: string[][] = [];
    let bootstrapped = "";
    const adapter: FrameworkAdapter = {
      onStarted: async () => {},
      onCleanup: async () => {},
      onEvent: async () => {
        running.resolve();
        await release.promise;
        settledBeforeItsTurnEnded.push(room.outcomes(bootstrapped));
      },
    };
    await using runtime = runtimeOn(platform);
    await runtime.start(adapter);

    const content = `${MENTION} bootstrapped`;
    bootstrapped = room.postBeforeConnect(USER, content);
    const bootstrapping = runtime.bootstrapRoomMessage("room-1", {
      id: bootstrapped,
      roomId: "room-1",
      content,
      senderId: USER,
      senderType: "User",
      senderName: USER,
      messageType: "text",
      metadata: {},
      createdAt: new Date(),
    });
    await running.promise;
    platform.transport.triggerRejoin(chatRoomTopic("room-1"));
    release.resolve();
    await bootstrapping;

    expect(await room.outcome(bootstrapped)).toBe("processed");
    expect(settledBeforeItsTurnEnded).toEqual([[]]);
    expect(room.outcomes(bootstrapped)).toEqual(["processed"]);
  });
});
