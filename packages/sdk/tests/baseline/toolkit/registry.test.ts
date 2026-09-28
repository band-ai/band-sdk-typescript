import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GenericAdapter } from "../../../src/adapters";
import {
  ADAPTER_IDS,
  AdapterRegistry,
  CATEGORIES,
  NON_ADAPTER_DIRS,
  registry,
  unmetRequirements,
  type AdapterId,
  type AdapterSpec,
  type Capability,
  type Dep,
} from "./registry";
import "./adapters";

const ADAPTERS_DIR = fileURLToPath(new URL("../../../src/adapters/", import.meta.url));
const SCENARIOS_DIR = fileURLToPath(new URL("../scenarios/", import.meta.url));
const NON_SCENARIO_DIRS = ["samples"];

function subdirectories(dir: string, excluded: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !excluded.includes(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Each source's members that are missing from the reference set. */
function drift(reference: readonly string[], sources: Record<string, readonly string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(sources).map(([name, members]) => [name, reference.filter((id) => !members.includes(id))]),
  );
}

describe("adapter registry drift guard", () => {
  it("ADAPTER_IDS, src/adapters/, and the populated registry name the same adapters", () => {
    const sources = {
      ADAPTER_IDS: [...ADAPTER_IDS],
      "src/adapters/": subdirectories(ADAPTERS_DIR, NON_ADAPTER_DIRS),
      registry: registry.ids(),
    };
    const union = [...new Set(Object.values(sources).flat())].sort();

    expect(drift(union, sources), "each source lists the adapters it is missing").toEqual({
      ADAPTER_IDS: [],
      "src/adapters/": [],
      registry: [],
    });
  });

  it("Category matches the folders under scenarios/", () => {
    expect(subdirectories(SCENARIOS_DIR, NON_SCENARIO_DIRS)).toEqual([...CATEGORIES].sort());
  });
});

const fakeBuild = () => new GenericAdapter(async () => {});

function fakeRegistry(entries: Record<string, readonly Capability[]>, pending: Partial<Record<AdapterId, string>> = {}): AdapterRegistry {
  const fake = new AdapterRegistry();
  for (const [id, supports] of Object.entries(entries)) {
    fake.register(id as AdapterId, { requires: [], supports, build: fakeBuild, pending: pending[id as AdapterId] });
  }
  return fake;
}

describe("specs()", () => {
  const fake = fakeRegistry({ openai: ["approvals"], codex: [], anthropic: [], letta: [] }, { letta: "needs a server" });

  it.each<{ name: string; filter: Parameters<AdapterRegistry["specs"]>[0]; expected: AdapterId[] }>([
    { name: "no filter keeps every adapter in id order", filter: {}, expected: ["anthropic", "codex", "openai"] },
    { name: "include keeps only the named adapters", filter: { include: ["codex", "openai"] }, expected: ["codex", "openai"] },
    { name: "exclude drops the named adapters", filter: { exclude: ["codex"] }, expected: ["anthropic", "openai"] },
    { name: "supports keeps adapters with every capability", filter: { supports: ["approvals"] }, expected: ["openai"] },
    { name: "without keeps adapters with none of the capabilities", filter: { without: ["approvals"] }, expected: ["anthropic", "codex"] },
    { name: "filters combine", filter: { without: ["approvals"], exclude: ["anthropic"] }, expected: ["codex"] },
    { name: "includePending keeps pending adapters", filter: { includePending: true, include: ["letta"] }, expected: ["letta"] },
  ])("$name", ({ filter, expected }) => {
    expect(fake.specs(filter).map((spec) => spec.id)).toEqual(expected);
  });

  it("rejects registering the same adapter twice", () => {
    expect(() => fakeRegistry({ codex: [] }).register("codex", { requires: [], supports: [], build: fakeBuild })).toThrow(
      /already registered/,
    );
  });
});

describe("unmetRequirements()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const specRequiring = (...requires: Dep[]): AdapterSpec => ({ id: "openai", requires, supports: [], build: fakeBuild });

  it("names every unmet requirement", () => {
    vi.stubEnv("BASELINE_SET", "value");
    vi.stubEnv("BASELINE_UNSET", "");

    const spec = specRequiring(
      { kind: "envVar", name: "BASELINE_SET" },
      { kind: "envVar", name: "BASELINE_UNSET" },
      { kind: "anyEnvVar", names: ["BASELINE_UNSET", "BASELINE_SET"] },
      { kind: "anyEnvVar", names: ["BASELINE_UNSET"] },
      { kind: "peerPackage", name: "vitest" },
      { kind: "peerPackage", name: "not-a-real-package" },
      { kind: "cli", command: "node" },
      { kind: "cli", command: "not-a-real-cli" },
    );

    expect(unmetRequirements(spec)).toEqual([
      "env var BASELINE_UNSET is not set",
      "none of BASELINE_UNSET is set",
      "package not-a-real-package is not installed",
      expect.stringMatching(/^CLI not-a-real-cli is unavailable: /),
    ]);
  });
});
