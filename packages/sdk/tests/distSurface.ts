import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import pkg from "../package.json" with { type: "json" };

// Helpers for asserting against the BUILT package rather than src. A src-only surface test
// cannot see a type/value mismatch under verbatimModuleSyntax, which is exactly the class
// of bug that let a class ship with no runtime binding on the root entry.

const SDK_ROOT = resolve(__dirname, "..");
const requireCjs = createRequire(import.meta.url);
const exportsMap = pkg.exports as Record<string, Record<string, string>>;

export type Mod = Record<string, unknown>;

/** Absolute path to a subpath's built entry for one of the package.json export conditions. */
export function distEntry(subpath: string, condition: "import" | "require" | "types"): string {
  const entry = exportsMap[subpath];
  if (!entry?.[condition]) {
    throw new Error(`package.json#exports is missing ${subpath} -> ${condition}`);
  }
  return resolve(SDK_ROOT, entry[condition]);
}

/** Loads a subpath's built ESM entry. */
export async function importDistEsm(subpath: string): Promise<Mod> {
  return (await import(pathToFileURL(distEntry(subpath, "import")).href)) as Mod;
}

/** Loads a subpath's built CJS entry. */
export function requireDistCjs(subpath: string): Mod {
  return requireCjs(distEntry(subpath, "require")) as Mod;
}

/** Source of a subpath's built declaration file — what a consumer's tsc actually reads. */
export function readDistTypes(subpath: string): string {
  return readFileSync(distEntry(subpath, "types"), "utf-8");
}
