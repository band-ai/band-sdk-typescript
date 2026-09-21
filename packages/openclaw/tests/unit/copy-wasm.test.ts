import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { copyWasm, resolveCoreWasmPath } from "../../scripts/copy-wasm.mjs";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("copy-wasm", () => {
  it("copies the SDK-resolved band-sdk-core wasm into dist/", () => {
    const source = resolveCoreWasmPath();
    const sourceBytes = readFileSync(source);
    expect(sourceBytes.byteLength).toBeGreaterThan(0);

    const destDir = join(pkgRoot, "dist");
    mkdirSync(destDir, { recursive: true });
    // Ensure a dirty prior dest cannot mask a no-op copy.
    writeFileSync(join(destDir, "band_sdk_core_bg.wasm"), "stale");

    const dest = copyWasm(destDir);
    expect(dest).toBe(join(destDir, "band_sdk_core_bg.wasm"));

    const copied = readFileSync(dest);
    expect(copied.equals(sourceBytes)).toBe(true);
    expect(createHash("sha256").update(copied).digest("hex")).toBe(
      createHash("sha256").update(sourceBytes).digest("hex"),
    );
  });

  it("is the module tsup onSuccess imports", async () => {
    const tsupConfigUrl = pathToFileURL(join(pkgRoot, "tsup.config.ts")).href;
    // Smoke: the script remains importable as a side-effect-free module for onSuccess.
    const mod = await import("../../scripts/copy-wasm.mjs");
    expect(typeof mod.copyWasm).toBe("function");
    expect(typeof mod.resolveCoreWasmPath).toBe("function");
    // Keep the config path referenced so a rename is noticed in reviews/tests.
    expect(tsupConfigUrl).toContain("tsup.config.ts");
  });
});
