import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CORE_WASM_FILENAME,
  assertNonEmptyWasm,
  copyWasm,
  resolveCoreWasmPath,
} from "../../scripts/copy-wasm.mjs";

describe("copy-wasm", () => {
  it("copies the SDK-resolved band-sdk-core wasm into the destination dir", async () => {
    const source = resolveCoreWasmPath();
    expect(source.replace(/\\/g, "/")).toContain("@band-ai/band-sdk-core");
    expect(source.replace(/\\/g, "/")).toMatch(new RegExp(`${CORE_WASM_FILENAME}$`));
    const sourceBytes = await import("node:fs").then((fs) => fs.readFileSync(source));
    expect(sourceBytes.byteLength).toBeGreaterThan(0);

    const destDir = await mkdtemp(join(tmpdir(), "openclaw-copy-wasm-"));
    writeFileSync(join(destDir, CORE_WASM_FILENAME), "stale");

    const dest = copyWasm(destDir);
    expect(dest).toBe(join(destDir, CORE_WASM_FILENAME));
    const copied = await import("node:fs").then((fs) => fs.readFileSync(dest));
    expect(copied.equals(sourceBytes)).toBe(true);
  });

  it("rejects an empty wasm path", async () => {
    const destDir = await mkdtemp(join(tmpdir(), "openclaw-copy-wasm-empty-"));
    const empty = join(destDir, CORE_WASM_FILENAME);
    writeFileSync(empty, "");
    expect(() => assertNonEmptyWasm(empty, "source wasm")).toThrow(/empty/);
  });
});
