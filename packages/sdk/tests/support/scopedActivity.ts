import { ExecutionContext } from "../../src/runtime/ExecutionContext";
import { bindWorkingCycle } from "../../src/runtime/workingState";
import { trackTurn } from "../../src/core/turn";
import { overrideTools } from "../../src/core/overrideTools";
import type { Activity } from "../../src/contracts/activity";
import type { AgentToolsCapabilities } from "../../src/contracts/protocols";
import type { AgentToolsRestApi } from "../../src/client/rest/types";
import { FakeRestApi, RecordLog } from "../testUtils";

export async function scopedActivity(rest: AgentToolsRestApi = new FakeRestApi(), capabilities?: Partial<AgentToolsCapabilities>) {
  const reports = new RecordLog<Activity | false>();
  const context = new ExecutionContext({ roomId: "room", maxContextMessages: 100, link: { rest, capabilities } });
  const lease = context.openWorkingCycle(async (working, options) => {
    reports.record(working ? options.activity as Activity : false);
  })!;
  await lease.ready;
  const tools = trackTurn(overrideTools(bindWorkingCycle(context.getTools(), lease), {}));
  return {
    tools, reports, context, lease,
    async [Symbol.asyncDispose]() { await lease.end(); await context.closeWorkingState(); },
  };
}
