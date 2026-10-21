import { expect, onTestFailed, onTestFinished } from "vitest";
import { z } from "zod";
import { createDeferred } from "../../../../src/core/deferred";
import { ADAPTER, buildClaudeSdk } from "../../toolkit/adapters";
import { activityPhases, nativeToolBarrier } from "../../toolkit/activityPhases";
import { withAdapters, type Cast } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms, ACTIVITY_EVENT } from "../../toolkit/rooms";
import { observeAgent, DELIVERY_STATUS } from "../../toolkit/observeDelivery";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { uniqueMarker } from "../samples/markers";

const SCENARIO = scenarioId(CATEGORY.platform, "activityDetail");
const LOCAL_TOOL = "activity_lookup";

interface ActivityProbe {
  phases: ReturnType<typeof activityPhases>;
  tool: string;
  marker: string;
  request: string;
  toolEntered: Promise<string>;
  releaseTool: () => void;
}

async function observeCycle(cast: Cast, { phases, tool, marker, request, toolEntered, releaseTool }: ActivityProbe) {
  const { agents: [agent], room } = cast;
  if (!agent) throw new Error("No activity test agent");
  // Each wait is an event; a cell that never gets its event only ends at the test limit, so say where it stopped.
  const stages: string[] = [];
  const at = async <T>(stage: string, event: Promise<T>): Promise<T> => { const seen = await event; stages.push(stage); return seen; };
  onTestFailed(() => console.error(`activityDetail stopped after "${stages.at(-1) ?? "start"}"; frames seen:`,
    room.activity.entries.filter((frame) => frame.agentId === agent.id)
      .map(({ event, executionId, activity }) => ({ event, executionId, activity }))));
  const from = room.activity.entries.length;
  const sent = await at("mention sent", Rooms.sendMention(room, agent, request));
  await at("adapter entered", phases.entered);
  const reasoning = await at("reasoning observed", room.activity.next((frame) => frame.agentId === agent.id && frame.activity?.kind === "reasoning", from));
  phases.enter();
  const active = await at("tool_call observed", room.activity.next((frame) => frame.agentId === agent.id && frame.executionId === reasoning.executionId &&
    frame.activity?.kind === "tool_call" && frame.activity.name === tool, room.activity.entries.indexOf(reasoning)));
  expect(await at("tool entered", toolEntered)).toBe(marker);
  releaseTool();
  await at("adapter returned", phases.returned);
  const resumed = await at("reasoning resumed", room.activity.next((frame) => frame.agentId === agent.id && frame.executionId === active.executionId &&
    frame.activity?.kind === "reasoning", room.activity.entries.indexOf(active) + 1));
  phases.finish();
  await at("stopped observed", room.activity.next((frame) => frame.agentId === agent.id && frame.executionId === active.executionId &&
    frame.event === ACTIVITY_EVENT.stopped, room.activity.entries.indexOf(resumed) + 1));
  assertDeliveryStatus(await observeAgent(agent, room).untilProcessed(sent), DELIVERY_STATUS.processed);
  expect(room.activity.entries.filter((frame) => frame.agentId === agent.id && frame.executionId === active.executionId &&
    JSON.stringify(frame.raw).includes(marker))).toEqual([]);
  expect(room.messages.entries.filter((message) => message.sender_id === agent.id &&
    (message.message_type === "tool_call" || message.message_type === "tool_result"))).toEqual([]);
}

let anthropic: ActivityProbe;
withAdapters([ADAPTER.anthropic], SCENARIO, async (cast) => {
  await observeCycle(cast, anthropic);
}, { build: (spec, options) => {
  const phases = activityPhases();
  const marker = uniqueMarker("activity-private");
  const release = createDeferred();
  const entered = createDeferred<string>();
  onTestFinished(() => release.resolve());
  anthropic = { phases, tool: LOCAL_TOOL, marker, request: `Call ${LOCAL_TOOL} with query="${marker}", then reply briefly.`, toolEntered: entered.promise, releaseTool: () => release.resolve() };
  return phases.wrap(spec.build({ ...options, reportToolCalls: false, customTools: [{
    name: LOCAL_TOOL, schema: z.object({ query: z.string() }),
    handler: async ({ query }) => { entered.resolve(String(query)); await release.promise; return "lookup complete"; },
  }] }));
} });

let claude: ActivityProbe;
withAdapters([ADAPTER.claudeSdk], SCENARIO, async (cast) => {
  await observeCycle(cast, claude);
}, { build: (_spec, options) => {
  const phases = activityPhases();
  const marker = uniqueMarker("activity-private");
  return phases.wrap(buildClaudeSdk(options, { enableExecutionReporting: false, permissionMode: "bypassPermissions" }), async () => {
    const barrier = await nativeToolBarrier(options.workDir, marker);
    claude = { phases, tool: "Bash", marker, request: `Run this exact command once using native Bash, then reply briefly:\n${barrier.command}`, toolEntered: barrier.entered, releaseTool: barrier.release };
  });
} });
