import { afterEach, describe, expect, it, vi } from "vitest";

import { GenericAdapter } from "../../../src/adapters";
import type { AgentIdentity } from "./agents";
import { perAdapter, runScenario, type OpenCell } from "./perAdapter";
import type { AdapterSpec } from "./registry";
import { ResourceStack } from "./resourceStack";
import type { Room } from "./rooms";

const fakeSpec = (overrides: Partial<AdapterSpec> = {}): AdapterSpec => ({
  id: "openai",
  requires: [],
  supports: [],
  build: () => new GenericAdapter(async () => {}),
  ...overrides,
});

/** An opener whose cell records its own release instead of touching the platform. */
function recordingOpener(released: string[]): OpenCell {
  return async (spec) => ({
    agent: { id: "agent" } as AgentIdentity,
    room: { id: "room" } as Room,
    cell: {} as never,
    [Symbol.asyncDispose]: async () => {
      released.push(spec.id);
    },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runScenario", () => {
  it("releases the cell when the scenario body throws", async () => {
    const released: string[] = [];

    await expect(
      runScenario(fakeSpec(), async () => {
        throw new Error("scenario failed");
      }, "prompt", recordingOpener(released)),
    ).rejects.toThrow("scenario failed");

    expect(released).toEqual(["openai"]);
  });

  it("fails loudly on an unmet requirement without opening a cell", async () => {
    vi.stubEnv("BASELINE_MISSING_KEY", "");
    const released: string[] = [];
    const spec = fakeSpec({ requires: [{ kind: "envVar", name: "BASELINE_MISSING_KEY" }] });

    await expect(runScenario(spec, async () => {}, "prompt", recordingOpener(released))).rejects.toThrow(
      "openai cannot run: env var BASELINE_MISSING_KEY is not set",
    );
    expect(released).toEqual([]);
  });
});

describe("ResourceStack", () => {
  it("releases last-first and keeps going past a failed release", async () => {
    const released: string[] = [];
    const resource = (name: string, fails = false): AsyncDisposable => ({
      [Symbol.asyncDispose]: async () => {
        released.push(name);
        if (fails) throw new Error(`${name} release failed`);
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    {
      await using stack = new ResourceStack();
      stack.use(resource("cell"));
      stack.use(resource("agent", true));
      stack.use(resource("room"));
    }

    expect(released).toEqual(["room", "agent", "cell"]);
  });
});

describe("perAdapter", () => {
  it("refuses a selection of no adapters instead of passing vacuously", () => {
    expect(() => perAdapter("platform.nothing", async () => {}, { supports: ["approvals"], without: ["approvals"] })).toThrow(
      /selects no adapters/,
    );
  });
});
