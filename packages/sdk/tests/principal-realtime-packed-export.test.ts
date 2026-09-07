import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("packed @band-ai/sdk/realtime export", () => {
  it("resolves createPrincipalRealtimeConnection from a packed tarball", () => {
    const pack = spawnSync("pnpm", ["pack", "--pack-destination", tmpdir()], {
      cwd: SDK_ROOT,
      encoding: "utf8",
    });
    expect(pack.status, pack.stderr + pack.stdout).toBe(0);
    const match = (pack.stdout + pack.stderr).match(/band-ai-sdk-[\d.]+\.tgz/);
    expect(match).toBeTruthy();
    const tarball = join(tmpdir(), match![0]);
    const consumer = mkdtempSync(join(tmpdir(), "realtime-pack-"));
    try {
      spawnSync("pnpm", ["init"], { cwd: consumer, encoding: "utf8" });
      const install = spawnSync("pnpm", ["add", tarball], {
        cwd: consumer,
        encoding: "utf8",
      });
      expect(install.status, install.stderr + install.stdout).toBe(0);
      writeFileSync(
        join(consumer, "smoke.mjs"),
        `import { createPrincipalRealtimeConnection, REALTIME_WORKING_AGENT_EXECUTION_MAX } from "@band-ai/sdk/realtime";
if (typeof createPrincipalRealtimeConnection !== "function") process.exit(2);
if (REALTIME_WORKING_AGENT_EXECUTION_MAX !== 32) process.exit(3);
`,
      );
      const run = spawnSync(process.execPath, [join(consumer, "smoke.mjs")], {
        cwd: consumer,
        encoding: "utf8",
      });
      expect(run.status, run.stderr + run.stdout).toBe(0);

      writeFileSync(
        join(consumer, "smoke.cjs"),
        `const realtime = require("@band-ai/sdk/realtime");
if (typeof realtime.createPrincipalRealtimeConnection !== "function") process.exit(2);
`,
      );
      const cjs = spawnSync(process.execPath, [join(consumer, "smoke.cjs")], {
        cwd: consumer,
        encoding: "utf8",
      });
      expect(cjs.status, cjs.stderr + cjs.stdout).toBe(0);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});

void pathToFileURL;
