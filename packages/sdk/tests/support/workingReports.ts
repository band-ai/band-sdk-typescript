import { onTestFinished, vi } from "vitest";
import type { FernRestAdapter } from "../../src/client/rest/FernRestAdapter";
import { RecordLog } from "../testUtils";

/** Records only completed reports, preserving the real client's HTTP and error behavior. */
export function recordSuccessfulWorkingReports(rest: Pick<FernRestAdapter, "reportActivity">): RecordLog<{ roomId: string; working: boolean }> {
  const reports = new RecordLog<{ roomId: string; working: boolean }>();
  const report = rest.reportActivity.bind(rest);
  const spy = vi.spyOn(rest, "reportActivity").mockImplementation(async (roomId, working, options) => {
    const result = await report(roomId, working, options);
    reports.record({ roomId, working });
    return result;
  });
  onTestFinished(() => spy.mockRestore());
  return reports;
}
