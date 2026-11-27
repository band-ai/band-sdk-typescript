import { open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** A promise that never settles: a child process holds on it until it is killed. */
export const never = (): Promise<never> => new Promise(() => undefined);

/**
 * Holds the first journal append whose line matches `match` until this process
 * dies. The same FileHandle.prototype patch the in-test fakes use, without
 * them: a child runtime is not a test, and the hold is meant to outlive every
 * release — the process is the release. `probeDir` hosts a throwaway file
 * that exposes the prototype.
 */
export async function holdFirstJournalAppend(probeDir: string, match: (line: string) => boolean): Promise<{ entered: Promise<void> }> {
  const probe = await open(path.join(probeDir, `append-probe-${randomUUID()}`), "w");
  const proto = Object.getPrototypeOf(probe) as { appendFile: (...args: unknown[]) => Promise<void> };
  await probe.close();
  const original = proto.appendFile;
  const entered = new Promise<void>((resolve) => {
    proto.appendFile = async function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] === "string" && match(args[0])) {
        proto.appendFile = original;
        resolve();
        await never();
      }
      return original.call(this, ...args);
    };
  });
  return { entered };
}
