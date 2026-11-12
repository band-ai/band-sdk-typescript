import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { onTestFinished, vi } from "vitest";

import { MS_PER_SECOND } from "../src/core/deadline";
import { createDeferred } from "../src/core/deferred";
import { DEFAULT_JOURNAL_RETENTION_SECONDS } from "../src/runtime/types";
import { tmpRoot } from "./testUtils";

/** The default retention, in the milliseconds `TurnJournal` takes. */
export const RETENTION_MS = DEFAULT_JOURNAL_RETENTION_SECONDS * MS_PER_SECOND;

type AppendFile = (...args: unknown[]) => Promise<void>;

/**
 * Replaces Node's `FileHandle.appendFile`, the fs boundary every journal write
 * goes through, with `append`, which gets the original; restored when the test ends.
 */
export async function interceptJournalAppends(append: (original: AppendFile, self: unknown, args: unknown[]) => Promise<void>): Promise<void> {
  const probe = await open(path.join(tmpRoot(), "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as { appendFile: AppendFile };
  await probe.close();
  const original = prototype.appendFile;
  const spy = vi.spyOn(prototype, "appendFile").mockImplementation(function (this: unknown, ...args: unknown[]) {
    return append(original, this, args);
  });
  onTestFinished(() => spy.mockRestore());
}

/** Holds the first journal append whose line matches `matches` until `release()`; the others write as usual. */
export async function holdJournalAppend(matches: (line: string) => boolean): Promise<{ entered: Promise<void>; release: () => void }> {
  const entered = createDeferred();
  const released = createDeferred();
  onTestFinished(() => released.resolve());
  let held = false;
  await interceptJournalAppends(async (original, self, args) => {
    if (!held && typeof args[0] === "string" && matches(args[0])) {
      held = true;
      entered.resolve();
      await released.promise;
    }
    return original.apply(self, args);
  });
  return { entered: entered.promise, release: () => released.resolve() };
}

/** The record types in a journal file, in order. */
export async function recordTypes(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8");
  return text.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { t: string }).t);
}
