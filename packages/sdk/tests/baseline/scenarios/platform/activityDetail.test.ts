import { expect, onTestFinished } from "vitest";
import { z } from "zod";
import { createDeferred } from "../../../../src/core/deferred";
import { ADAPTER } from "../../toolkit/adapters";
import { activityPhases } from "../../toolkit/activityPhases";
import { withAdapters, type Cast } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms, ACTIVITY_EVENT } from "../../toolkit/rooms";
import { observeAgent, DELIVERY_STATUS } from "../../toolkit/observeDelivery";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { uniqueMarker } from "../samples/markers";

const SCENARIO = scenarioId(CATEGORY.platform, "activityDetail");
const LOCAL_TOOL = "activity_lookup";

async function observeCycle(cast: Cast, phases: ReturnType<typeof activityPhases>, tool: string, marker: string,
  request: string, releaseTool: () => void, toolEntered: Promise<string>) {
  const { agents: [agent], room } = cast;
  if (!agent) throw new Error("No activity test agent");
  const from = room.activity.entries.length;
  const sent = await Rooms.sendMention(room, agent, request);
  await phases.entered;
  const reasoning = await room.activity.next((frame) => frame.agentId === agent.id && frame.activity?.kind === "reasoning", from);
  phases.enter();
  const active = await room.activity.next((frame) => frame.agentId === agent.id && frame.executionId === reasoning.executionId &&
    frame.activity?.kind === "tool_call" && frame.activity.name === tool, room.activity.entries.indexOf(reasoning));
  expect(await toolEntered).toBe(marker);
  releaseTool();
  await phases.returned;
  const resumed = await room.activity.next((frame) => frame.agentId === agent.id && frame.executionId === active.executionId &&
    frame.activity?.kind === "reasoning", room.activity.entries.indexOf(active) + 1);
  phases.finish();
  await room.activity.next((frame) => frame.agentId === agent.id && frame.executionId === active.executionId &&
    frame.event === ACTIVITY_EVENT.stopped, room.activity.entries.indexOf(resumed) + 1);
  assertDeliveryStatus(await observeAgent(agent, room).untilProcessed(sent), DELIVERY_STATUS.processed);
  expect(room.activity.entries.filter((frame) => frame.agentId === agent.id && frame.executionId === active.executionId)
    .every((frame) => !JSON.stringify(frame.raw).includes(marker))).toBe(true);
  expect(room.messages.entries.filter((message) => message.sender_id === agent.id &&
    (message.message_type === "tool_call" || message.message_type === "tool_result"))).toEqual([]);
}

let anthropic: { phases: ReturnType<typeof activityPhases>; marker: string; release: () => void; entered: Promise<string> };
withAdapters([ADAPTER.anthropic], SCENARIO, async (cast) => {
  const { phases, marker, release, entered } = anthropic;
  try {
    await observeCycle(cast, phases, LOCAL_TOOL, marker, `Call ${LOCAL_TOOL} with query="${marker}", then reply briefly.`, release, entered);
  } finally { release(); phases.release(); }
}, { build: (spec, options) => {
  const phases = activityPhases();
  const marker = uniqueMarker("activity-private");
  const release = createDeferred();
  const entered = createDeferred<string>();
  onTestFinished(() => release.resolve());
  anthropic = { phases, marker, release: () => release.resolve(), entered: entered.promise };
  return phases.wrap(spec.build({ ...options, reportToolCalls: false, customTools: [{
    name: LOCAL_TOOL, schema: z.object({ query: z.string() }),
    handler: async ({ query }) => { entered.resolve(String(query)); await release.promise; return "lookup complete"; },
  }] }));
} });
