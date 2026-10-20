import { ExecutionContext } from "../../src/runtime/ExecutionContext";
import { bindWorkingCycle } from "../../src/runtime/workingState";
import { trackTurn } from "../../src/core/turn";
import { overrideTools } from "../../src/core/overrideTools";
import type { Activity } from "../../src/contracts/activity";
import type { AgentToolsCapabilities } from "../../src/contracts/protocols";
import type { AgentToolsRestApi } from "../../src/client/rest/types";
import { createDeferred } from "../../src/core/deferred";
import { FakeRestApi, RecordLog } from "../testUtils";

export async function scopedActivity(rest: AgentToolsRestApi = new FakeRestApi(), capabilities?: Partial<AgentToolsCapabilities>) {
  const reports = new RecordLog<Activity | false>();
  let gate: Promise<void> | undefined;
  let releaseGate = () => {};
  const context = new ExecutionContext({ roomId: "room", maxContextMessages: 100, link: { rest, capabilities } });
  const lease = context.openWorkingCycle(async (working, options) => {
    await gate;
    reports.record(working ? options.activity as Activity : false);
  })!;
  await lease.ready;
  const tools = trackTurn(overrideTools(bindWorkingCycle(context.getTools(), lease), {}));
  /** Stalls report delivery, like a hung activity endpoint, until the returned release is called. */
  const hold = (): (() => void) => {
    const held = createDeferred();
    gate = held.promise;
    releaseGate = () => held.resolve();
    return releaseGate;
  };
  return {
    tools, reports, context, lease, hold,
    async [Symbol.asyncDispose]() { releaseGate(); await lease.end(); await context.closeWorkingState(); },
  };
}
