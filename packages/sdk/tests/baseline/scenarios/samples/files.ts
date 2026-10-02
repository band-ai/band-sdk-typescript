import { readFile } from "node:fs/promises";

/** A file an agent wrote or left behind, read as text. */
export function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}
