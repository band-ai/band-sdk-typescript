/**
 * Band's stop and play reach the TypeScript runtime and keep its turns in line
 * with the platform, whether or not Band's best-effort `agent.control` push
 * arrives: a stop is also found from Band refusing the agent's writes, and a
 * missed play from the stopped room's periodic `/messages/next` check.
 *
 * The cross-system half the unit tests cannot prove: Band keeps a stopped
 * turn's message actionable (`/messages/next` still serves it while it is
 * `processing`) and serves it again on play, so it is processed exactly once
 * the room resumes. Runs no LLM: the handler is deterministic.
 */
import { describe, expect, it, onTestFinished } from "vitest";

import { GenericAdapter } from "../../../../src/index";
import type { AgentEvent } from "../../../../src/contracts/events";
import { NO_REPLY_TOOL_NAME } from "../../../../src/contracts/toolSchemas";
import { createDeferred } from "../../../../src/core/deferred";
import { RecordLog } from "../../../testUtils";
import { Agents, type RunningAgent } from "../../toolkit/agents";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { AGENT_CONTROL, Rooms } from "../../toolkit/rooms";

const SCENARIO = scenarioId(CATEGORY.behavior, "controlSignals");

/** Short, so a play whose push was missed is found within a scenario's wait. */
const STOPPED_RESYNC_SECONDS = 5;

/** Records what the agent reports, for waiting on and ordering its pauses and turns. */
function recordEvents(running: RunningAgent): RecordLog<AgentEvent> {
  const events = new RecordLog<AgentEvent>();
  onTestFinished(running.observe((event) => events.record(event)));
  return events;
}

const inRoom = (roomId: string, type: AgentEvent["type"]) => (event: AgentEvent) =>
  event.type === type && "roomId" in event && event.roomId === roomId;

describe(SCENARIO, () => {
  it("replays a stopped turn's message once Band plays the room, and processes it once", async () => {
    await using identity = await Agents.provision(SCENARIO, "stop-play");
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, identity);
    const entered = createDeferred();
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    const handled = new RecordLog<string>();
    const adapter = new GenericAdapter(async ({ message, tools }) => {
      handled.record(message.id);
      if (handled.entries.length === 1) {
        entered.resolve();
        await release.promise;
      }
      await tools.executeToolCall(NO_REPLY_TOOL_NAME, {});
    });
    await using running = await Agents.runAs(identity, adapter, { sessionConfig: { stoppedResyncSeconds: STOPPED_RESYNC_SECONDS } });
    const events = recordEvents(running);
    const delivery = observeAgent(identity, room);

    const sent = await Rooms.sendMention(room, identity, "Hold until released, then finish without a reply.");
    await entered.promise;
    await Rooms.controlAgents(room, AGENT_CONTROL.stop);
    // Pushed, or found when Band refuses the turn's acknowledgement once it finishes.
    release.resolve();
    await events.next(inRoom(room.id, "room.paused"));
    expect(delivery.status(sent)).not.toBe(DELIVERY_STATUS.processed);

    await Rooms.controlAgents(room, AGENT_CONTROL.play);

    assertDeliveryStatus(await delivery.untilProcessed(sent), DELIVERY_STATUS.processed, "replayed on play");
    expect(handled.entries).toEqual([sent.id, sent.id]);
  });

  it("takes no turn in a stopped room until Band plays it", async () => {
    await using identity = await Agents.provision(SCENARIO, "stopped-room");
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, identity);
    const handled = new RecordLog<string>();
    const adapter = new GenericAdapter(async ({ message, tools }) => {
      handled.record(message.id);
      await tools.executeToolCall(NO_REPLY_TOOL_NAME, {});
    });
    await using running = await Agents.runAs(identity, adapter, { sessionConfig: { stoppedResyncSeconds: STOPPED_RESYNC_SECONDS } });
    const events = recordEvents(running);
    const delivery = observeAgent(identity, room);
    onTestFinished(() => Rooms.controlAgents(room, AGENT_CONTROL.play).catch(() => undefined));

    await Rooms.controlAgents(room, AGENT_CONTROL.stop);
    const sent = await Rooms.sendMention(room, identity, "Sent while the room is stopped.");
    // Pushed, or found when Band refuses the turn's claim.
    await events.next(inRoom(room.id, "room.paused"));
    await Rooms.controlAgents(room, AGENT_CONTROL.play);

    assertDeliveryStatus(await delivery.untilProcessed(sent), DELIVERY_STATUS.processed, "run once played");
    const resumedAt = events.entries.findIndex(inRoom(room.id, "room.resumed"));
    const startedAt = events.entries.findIndex(inRoom(room.id, "turn.started"));
    expect(resumedAt).toBeGreaterThanOrEqual(0);
    expect(startedAt).toBeGreaterThan(resumedAt);
    expect(handled.entries).toEqual([sent.id]);
  });
});
