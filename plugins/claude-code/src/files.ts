import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const PARTIAL_EXTENSION = ".partial";

/** Replaces the file whole, so another process reading it never parses half of it. */
export function writeFileAtomically(path: string, data: string, mode?: number): void {
  const partial = `${path}${PARTIAL_EXTENSION}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(partial, data, { mode });
  if (mode !== undefined) {
    // The mode applies only when the file is created.
    chmodSync(partial, mode);
  }
  renameSync(partial, path);
}
