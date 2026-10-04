import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = join(__dirname, "../..");
const script = join(packageRoot, "scripts/sync-plugin-version.js");
// The band-sdk-core the SDK itself depends on — the wasm the bundled glue loads.
const sdkCorePackageJson = join(packageRoot, "../../packages/sdk/node_modules/@band-ai/band-sdk-core/package.json");

describe("sync-plugin-version", () => {
  it("stamps the package version and the SDK's band-sdk-core version into source and dist plugin.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-sync-version-"));
    try {
      // A stale plugin checkout that resolves @band-ai/sdk through the real workspace install.
      symlinkSync(join(packageRoot, "node_modules"), join(dir, "node_modules"), "junction");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@band-ai/openclaw-channel-band", version: "9.8.7" }));
      writeFileSync(
        join(dir, "openclaw.plugin.json"),
        JSON.stringify({ id: "openclaw-channel-band", version: "0.0.0", bandSdkCoreVersion: "0.0.0" }),
      );
      mkdirSync(join(dir, "dist"));

      const result = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);

      const coreVersion = JSON.parse(readFileSync(sdkCorePackageJson, "utf8")).version;
      for (const file of ["openclaw.plugin.json", "dist/openclaw.plugin.json"]) {
        expect(JSON.parse(readFileSync(join(dir, file), "utf8"))).toEqual({
          id: "openclaw-channel-band",
          version: "9.8.7",
          bandSdkCoreVersion: coreVersion,
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
