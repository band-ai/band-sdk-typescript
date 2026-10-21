import { onTestFinished, vi } from "vitest";
import { BandLink } from "../../src/platform/BandLink";
import type { Activity } from "../../src/contracts/activity";
import { RecordLog } from "../testUtils";

export interface RuntimeActivityReport {
  roomId: string;
  working: boolean;
  activity?: Activity;
}

/** Observe the real reporter boundary, including legacy links that conservatively strip detail. */
export function recordRuntimeActivity(): RecordLog<RuntimeActivityReport> {
  const reports = new RecordLog<RuntimeActivityReport>();
  const report = BandLink.prototype.reportActivity;
  const spy = vi.spyOn(BandLink.prototype, "reportActivity").mockImplementation(async function (this: BandLink, roomId, working, options) {
    const result = await report.call(this, roomId, working, options);
    reports.record({ roomId, working, ...(options?.activity ? { activity: { ...options.activity } as Activity } : {}) });
    return result;
  });
  onTestFinished(() => spy.mockRestore());
  return reports;
}

/** The activity each report published, with `false` standing for a stop. */
export function activitySequence(reports: RecordLog<RuntimeActivityReport>): Array<Activity | false | undefined> {
  return reports.entries.map(({ working, activity }) => working ? activity : false);
}
