import type { ChildProcess } from "node:child_process";

/** How long a stopping child gets after stdin closes before SIGTERM, then SIGKILL. */
export const CHILD_STOP_GRACE_MS = { term: 500, kill: 1_500 } as const;

/**
 * Lets the child exit on EOF, then escalates to SIGTERM and SIGKILL. When
 * draining stdin is disabled, sends SIGTERM immediately so the child can clean up.
 */
export async function stopChildProcess(
  child: ChildProcess,
  { drainStdin = true }: { drainStdin?: boolean } = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (drainStdin) child.stdin?.end();
  await new Promise<void>((resolve) => {
    const terminate = () => child.kill("SIGTERM");
    const term = drainStdin ? setTimeout(terminate, CHILD_STOP_GRACE_MS.term) : undefined;
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
    if (!drainStdin) terminate();
  });
}
