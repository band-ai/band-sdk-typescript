import { onTestFinished } from "vitest";
import type { Activity } from "../../src/contracts/activity";
import type { FrameworkAdapter } from "../../src/contracts/protocols";
import { BandPlatform, person } from "../flows/support/bandPlatform";
import { recordRuntimeActivity, type RuntimeActivityReport } from "./activityReports";
import type { RecordLog } from "../testUtils";
import { SlowFailureRest } from "./slowFailureRest";

const HEARTBEAT = { enableWorkingState: true, workingKeepAliveSeconds: 0.02, workingRequestTimeoutSeconds: 0.01 };

/**
 * Runs one turn on `adapter` whose provider fails while a native tool or wait is still open, and returns what a
 * heartbeat reported while the failure was still being delivered. A provider boundary that ends its native
 * activity reports reasoning there. `opened` waits until the provider has opened what it will leave open, and
 * `reports` is the recorder a provider script waits on, when it needs one.
 */
export async function activityWhileProviderFails(
  adapter: FrameworkAdapter,
  { opened = async () => {}, reports = recordRuntimeActivity() }: { opened?: () => Promise<void>; reports?: RecordLog<RuntimeActivityReport> } = {},
): Promise<Activity | undefined> {
  const rest = new SlowFailureRest([person("owner")]);
  onTestFinished(() => rest.gate.resolve());
  const platform = await BandPlatform.start(adapter, [person("owner")], rest, HEARTBEAT);
  onTestFinished(() => platform[Symbol.asyncDispose]());
  const room = await platform.room("room-1");
  const message = await room.say("owner", "run it");
  await opened();
  await rest.failurePosting.promise;
  const heartbeat = await reports.next(() => true, reports.entries.length);
  rest.gate.resolve();
  if (await room.outcome(message) !== "failed") throw new Error("The turn was expected to fail");
  return heartbeat.activity;
}
