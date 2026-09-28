import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GenericAdapter } from "../../../src/adapters";
import { ADAPTER, ADAPTER_IDS } from "./adapters";
import {
  AdapterRegistry,
  CAPABILITY,
  CATEGORIES,
  NON_ADAPTER_DIRS,
  requires,
  unmetRequirements,
  type AdapterSpec,
  type Capability,
  type Dep,
} from "./registry";

const ADAPTERS_DIR = fileURLToPath(new URL("../../../src/adapters/", import.meta.url));
const SCENARIOS_DIR = fileURLToPath(new URL("../scenarios/", import.meta.url));
/** Shared scenario pieces, not a category. */
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
  it("the roster in adapters.ts and src/adapters/ name the same adapters", () => {
    const sources = {
      roster: [...ADAPTER_IDS],
      "src/adapters/": subdirectories(ADAPTERS_DIR, NON_ADAPTER_DIRS),
    };
    const union = [...new Set(Object.values(sources).flat())].sort();

    expect(drift(union, sources), "each source lists the adapters it is missing").toEqual({
      roster: [],
      "src/adapters/": [],
    });
  });

  it("Category matches the folders under scenarios/", () => {
    expect(subdirectories(SCENARIOS_DIR, NON_SCENARIO_DIRS)).toEqual([...CATEGORIES].sort());
  });
});

const fakeBuild = () => new GenericAdapter(async () => {});

const fakeSpec = (id: string, supports: readonly Capability[] = [], pending?: string): AdapterSpec => ({
  id,
  requires: [],
  supports,
  build: fakeBuild,
  pending,
});

describe("specs()", () => {
  const fake = new AdapterRegistry([
    fakeSpec(ADAPTER.openai, [CAPABILITY.approvals]),
    fakeSpec(ADAPTER.codex),
    fakeSpec(ADAPTER.anthropic),
    fakeSpec(ADAPTER.letta, [], "needs a server"),
  ]);

  it.each<{ name: string; filter: Parameters<AdapterRegistry["specs"]>[0]; expected: string[] }>([
    { name: "no filter keeps every adapter in id order", filter: {}, expected: [ADAPTER.anthropic, ADAPTER.codex, ADAPTER.openai] },
    { name: "include keeps only the named adapters", filter: { include: [ADAPTER.codex, ADAPTER.openai] }, expected: [ADAPTER.codex, ADAPTER.openai] },
    { name: "exclude drops the named adapters", filter: { exclude: [ADAPTER.codex] }, expected: [ADAPTER.anthropic, ADAPTER.openai] },
    { name: "supports keeps adapters with every capability", filter: { supports: [CAPABILITY.approvals] }, expected: [ADAPTER.openai] },
    { name: "without keeps adapters with none of the capabilities", filter: { without: [CAPABILITY.approvals] }, expected: [ADAPTER.anthropic, ADAPTER.codex] },
    { name: "filters combine", filter: { without: [CAPABILITY.approvals], exclude: [ADAPTER.anthropic] }, expected: [ADAPTER.codex] },
    { name: "includePending keeps pending adapters", filter: { includePending: true, include: [ADAPTER.letta] }, expected: [ADAPTER.letta] },
  ])("$name", ({ filter, expected }) => {
    expect(fake.specs(filter).map((spec) => spec.id)).toEqual(expected);
  });

  it("rejects registering the same adapter twice", () => {
    expect(() => new AdapterRegistry([fakeSpec(ADAPTER.codex), fakeSpec(ADAPTER.codex)])).toThrow(/registered twice/);
  });
});

describe("unmetRequirements()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const specRequiring = (...deps: Dep[]): AdapterSpec => ({ ...fakeSpec(ADAPTER.openai), requires: deps });

  it("names every unmet requirement", () => {
    vi.stubEnv("BASELINE_SET", "value");
    vi.stubEnv("BASELINE_UNSET", "");

    const spec = specRequiring(
      requires.envVar("BASELINE_SET"),
      requires.envVar("BASELINE_UNSET"),
      requires.anyEnvVar("BASELINE_UNSET", "BASELINE_SET"),
      requires.anyEnvVar("BASELINE_UNSET"),
      requires.peerPackage("vitest"),
      requires.peerPackage("not-a-real-package"),
      requires.cli("node"),
      requires.cli("not-a-real-cli"),
    );

    expect(unmetRequirements(spec)).toEqual([
      "env var BASELINE_UNSET is not set",
      "none of BASELINE_UNSET is set",
      "package not-a-real-package is not installed",
      expect.stringMatching(/^CLI not-a-real-cli is unavailable: /),
    ]);
  });
});
