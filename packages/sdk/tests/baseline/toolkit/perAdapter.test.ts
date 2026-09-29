import { afterEach, describe, expect, it, vi } from "vitest";

import { ADAPTER } from "./adapters";
import type { AgentIdentity } from "./agents";
import { fakeSpec } from "./fakeSpec";
import { perAdapter, runScenario, type OpenCast } from "./perAdapter";
import { CAPABILITY, CATEGORY, requires, scenarioId } from "./registry";
import { ResourceStack } from "./resourceStack";
import type { Room } from "./rooms";

/** An opener whose cast records its own release instead of touching the platform. */
function recordingOpener(released: string[]): OpenCast {
  return async (chosen) => ({
    agents: [{ id: "agent" } as AgentIdentity],
    room: { id: "room" } as Room,
    cells: [],
    [Symbol.asyncDispose]: async () => {
      released.push(...chosen.map((spec) => spec.id));
    },
  });
}

const setup = { prompt: "prompt" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runScenario", () => {
  it("releases the cell when the scenario body throws", async () => {
    const released: string[] = [];

    await expect(
      runScenario([fakeSpec(ADAPTER.openai)], async () => {
        throw new Error("scenario failed");
      }, setup, recordingOpener(released)),
    ).rejects.toThrow("scenario failed");

    expect(released).toEqual([ADAPTER.openai]);
  });

  it("fails loudly on an unmet requirement without opening a cell", async () => {
    vi.stubEnv("BASELINE_MISSING_KEY", "");
    const released: string[] = [];
    const spec = fakeSpec(ADAPTER.openai, { requires: [requires.envVar("BASELINE_MISSING_KEY")] });

    await expect(runScenario([spec], async () => {}, setup, recordingOpener(released))).rejects.toThrow(
      "cannot run: openai: env var BASELINE_MISSING_KEY is not set",
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
    expect(() => perAdapter(scenarioId(CATEGORY.platform, "nothing"), async () => {}, {
        supports: [CAPABILITY.approvals],
        without: [CAPABILITY.approvals],
      })).toThrow(
      /selects no adapters/,
    );
  });
});
