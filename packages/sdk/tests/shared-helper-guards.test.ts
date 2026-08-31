import { readdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = resolve(fileURLToPath(new URL(".", import.meta.url)), "../src");

/**
 * Another in-flight ticket owns this file's lifecycle rework, including its one bare throw,
 * its inline error-message expression and its duplicate exhaustiveness helper. Converting
 * them here would collide with that change, so the guards below skip it. Delete this
 * constant — and the exclusions that reference it — once that work lands.
 */
const FILE_OWNED_BY_ANOTHER_CHANGE = "runtime/PlatformRuntime.ts";

function readSources(dir: string = SRC): Array<readonly [string, string]> {
  const found: Array<readonly [string, string]> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...readSources(full));
    } else if (entry.name.endsWith(".ts")) {
      found.push([full.slice(SRC.length + 1).split(sep).join("/"), readFileSync(full, "utf-8")]);
    }
  }
  return found;
}

const SOURCES = readSources();

function filesMatching(pattern: RegExp, { skipOwnedFile = true } = {}): string[] {
  return SOURCES
    .filter(([rel]) => !(skipOwnedFile && rel === FILE_OWNED_BY_ANOTHER_CHANGE))
    .filter(([, source]) => pattern.test(source))
    .map(([rel]) => rel);
}

function declarationsOf(name: string): string[] {
  const declaration = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function ${name}\\b`, "m");
  return filesMatching(declaration, { skipOwnedFile: false });
}

describe("errors thrown from src/ come from the typed hierarchy", () => {
  it("no bare `throw new Error(` remains", () => {
    expect(filesMatching(/throw new Error\(/)).toEqual([]);
  });

  // The lint rule bans `new Error` inside a throw, which includes the ternary re-wrap
  // form. One file is excluded because another in-flight ticket owns it; if that file
  // stops throwing a bare Error, this fails so the exclusion cannot outlive its reason.
  it("the one lint exclusion is still earning its place", () => {
    const source = readFileSync(resolve(SRC, FILE_OWNED_BY_ANOTHER_CHANGE), "utf-8");
    expect(
      /throw[^;]*new Error\(/.test(source),
      "the exclusion is stale -- drop it and the lint-config exclusion with it",
    ).toBe(true);
  });
});

describe("error-message extraction has one implementation", () => {
  it("no inline `x instanceof Error ? x.message : String(x)` remains", () => {
    const inline = /([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s+instanceof\s+Error\s*\?\s*\1\.message\s*:\s*String\(\1\)/;
    expect(filesMatching(inline)).toEqual([]);
  });

  it("asErrorMessage and serializeError are each declared once", () => {
    expect(declarationsOf("asErrorMessage")).toEqual(["core/errors.ts"]);
    expect(declarationsOf("serializeError")).toEqual(["core/errors.ts"]);
  });
});

describe("the shared coercion helpers have exactly one home", () => {
  const HELPERS = [
    "asNonEmptyString",
    "asOptionalRecord",
    "asRecord",
    "asRecordArray",
    "asString",
    "asNullableString",
    "toWireString",
    "toDisplayText",
    "isRecord",
  ];

  it.each(HELPERS)("%s is declared exactly once", (helper) => {
    expect(declarationsOf(helper)).toEqual(["adapters/shared/coercion.ts"]);
  });
});

describe("sleep and assertNever have exactly one home", () => {
  it("sleep is declared once", () => {
    expect(declarationsOf("sleep")).toEqual(["core/sleep.ts"]);
  });

  it("assertNever is declared once outside the file another change owns", () => {
    expect(declarationsOf("assertNever").filter((rel) => rel !== FILE_OWNED_BY_ANOTHER_CHANGE))
      .toEqual(["core/errors.ts"]);
  });
});

/**
 * The message-drop defect in these two adapters is tracked separately. Consolidating the
 * helpers around them must not quietly absorb it in either direction, so pin the fact that
 * each adapter still carries its own copy of this function.
 */
describe("selectCompleteExchanges stays untouched by the helper consolidation", () => {
  it.each([
    "adapters/letta/LettaAdapter.ts",
    "adapters/parlant/ParlantAdapter.ts",
  ])("%s still declares its own selectCompleteExchanges", (rel) => {
    const source = readFileSync(resolve(SRC, rel), "utf-8");
    expect(source).toMatch(/^function selectCompleteExchanges\(/m);
  });

  it("no shared selectCompleteExchanges was introduced", () => {
    expect(declarationsOf("selectCompleteExchanges").sort()).toEqual([
      "adapters/letta/LettaAdapter.ts",
      "adapters/parlant/ParlantAdapter.ts",
    ]);
  });
});
