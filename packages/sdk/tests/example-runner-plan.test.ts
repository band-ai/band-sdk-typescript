import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

import { assertReplyOnlyBarrier } from "../scripts/example-runner-barriers";

const SDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("example-runner plan validation", () => {
  it("accepts the checked-in basic-echo plan shape", async () => {
    const planPath = path.join(SDK_ROOT, "scripts", "example-plans", "basic-echo.yaml");
    const raw = loadYaml(await readFile(planPath, "utf8")) as { version?: number; examples?: unknown[] };
    expect(raw.version).toBe(1);
    expect(raw.examples?.length).toBeGreaterThan(0);
    const steps = (raw.examples?.[0] as { steps?: Array<{ barrier?: string }> })?.steps ?? [];
    for (const step of steps) {
      assertReplyOnlyBarrier(step.barrier ?? "reply");
    }
  });

  it("rejects processed barriers at parse time", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "band-plan-"));
    const planPath = path.join(dir, "bad.yaml");
    await writeFile(
      planPath,
      `version: 1
examples:
  - id: x
    path: examples/basic/basic-agent.ts
    config_key: basic_agent
    steps:
      - prompt: "hi"
        barrier: processed
`,
    );
    try {
      const raw = loadYaml(await readFile(planPath, "utf8")) as {
        examples?: Array<{ steps?: Array<{ barrier?: string }> }>;
      };
      const barrier = raw.examples?.[0]?.steps?.[0]?.barrier ?? "reply";
      expect(() => assertReplyOnlyBarrier(barrier)).toThrow(/unsupported barrier/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
