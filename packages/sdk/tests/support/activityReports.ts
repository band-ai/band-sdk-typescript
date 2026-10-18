import { onTestFinished, vi } from "vitest";
import { BandLink } from "../../src/platform/BandLink";
import type { Activity } from "../../src/contracts/activity";
import { RecordLog } from "../testUtils";

/** Observe the real reporter boundary, including legacy links that conservatively strip detail. */
export function recordRuntimeActivity(): RecordLog<{ roomId: string; working: boolean; activity?: Activity }> {
  const reports = new RecordLog<{ roomId: string; working: boolean; activity?: Activity }>();
  const report = BandLink.prototype.reportActivity;
  const spy = vi.spyOn(BandLink.prototype, "reportActivity").mockImplementation(async function (this: BandLink, roomId, working, options) {
    const result = await report.call(this, roomId, working, options);
    reports.record({ roomId, working, ...(options?.activity ? { activity: { ...options.activity } as Activity } : {}) });
    return result;
  });
  onTestFinished(() => spy.mockRestore());
  return reports;
}
