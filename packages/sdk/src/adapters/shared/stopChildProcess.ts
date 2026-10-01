import type { ChildProcess } from "node:child_process";

/** How long a stopping child gets after stdin closes before SIGTERM, then SIGKILL. */
export const CHILD_STOP_GRACE_MS = { term: 500, kill: 1_500 } as const;

/**
 * Closes the child's stdin so it can exit cleanly, then escalates to SIGTERM and
 * SIGKILL, so a child that ignores both EOF and SIGTERM cannot outlive its stop.
 */
export async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.stdin?.end();
  await new Promise<void>((resolve) => {
    const term = setTimeout(() => child.kill("SIGTERM"), CHILD_STOP_GRACE_MS.term);
    const kill = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, CHILD_STOP_GRACE_MS.kill);
    function finish(): void {
      clearTimeout(term);
      clearTimeout(kill);
      child.off("exit", finish);
      child.off("close", finish);
      resolve();
    }
    child.once("exit", finish);
    child.once("close", finish);
  });
}
