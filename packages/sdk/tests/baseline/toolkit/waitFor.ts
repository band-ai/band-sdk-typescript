import { withTimeout } from "../../../src/adapters/shared/withTimeout";
import type { RecordLog } from "../../testUtils";

class WaitTimedOut extends Error {}

/** What `find` reports over `log` once it reports anything, or undefined if `timeoutMs` elapses first. */
export async function waitFor<T>(log: RecordLog<unknown>, find: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  try {
    await withTimeout(log.until(() => find() !== undefined), timeoutMs, () => new WaitTimedOut());
    return find();
  } catch (error) {
    if (error instanceof WaitTimedOut) {
      return undefined;
    }
    throw error;
  }
}
