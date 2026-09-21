import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { copyWasm, resolveCoreWasmPath } from "../../scripts/copy-wasm.mjs";

describe("copy-wasm", () => {
  it("copies the SDK-resolved band-sdk-core wasm into the destination dir", async () => {
    const source = resolveCoreWasmPath();
    const sourceBytes = readFileSync(source);
    expect(sourceBytes.byteLength).toBeGreaterThan(0);

    const destDir = await mkdtemp(join(tmpdir(), "openclaw-copy-wasm-"));
    mkdirSync(destDir, { recursive: true });
    // Ensure a dirty prior dest cannot mask a no-op copy.
    writeFileSync(join(destDir, "band_sdk_core_bg.wasm"), "stale");

    const dest = copyWasm(destDir);
    expect(dest).toBe(join(destDir, "band_sdk_core_bg.wasm"));
    expect(readFileSync(dest).equals(sourceBytes)).toBe(true);
  });
});
