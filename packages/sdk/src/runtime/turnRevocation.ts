import { RuntimeStateError } from "../core/errors";
import { guardedTools } from "../core/overrideTools";

/**
 * `tools`, refusing every method call once `stopped` aborts. A turn a pause
 * or an interrupt cut short may keep running in an adapter that cannot
 * cancel it; nothing it does after that reaches Band, so a room that resumes
 * never holds both its reply and the replay's.
 */
export function revokedOnStop<T extends object>(tools: T, stopped: AbortSignal): T {
  return guardedTools(tools, () => {
    if (stopped.aborted) {
      throw new RuntimeStateError(`This turn was cut short (${String(stopped.reason)}); its tools no longer act`);
    }
  });
}
