/**
 * Copy band_sdk_core_bg.wasm next to a plugin's bundled JS.
 *
 * Plugin builds inline @band-ai/sdk (and thus band-sdk-core's JS glue) into
 * dist/, but the glue still loads the .wasm from __dirname at runtime.
 * Resolve the wasm from the same @band-ai/band-sdk-core package that
 * @band-ai/sdk depends on — not a separate plugin pin — so glue and wasm
 * cannot drift.
 */

import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const CORE_WASM_FILENAME = "band_sdk_core_bg.wasm";

export function assertNonEmptyWasm(path, label) {
  const size = statSync(path).size;
  if (size === 0) {
    throw new Error(`[copy-wasm] ${label} is empty: ${path}`);
  }
}

/** Resolve the band-sdk-core entry that the @band-ai/sdk seen from `packageRoot` loads. */
export function resolveCoreEntry(packageRoot) {
  // Resolve through an @band-ai/sdk module file so Node uses the SDK package's
  // dependency graph (exports block "@/package.json" subpath access).
  const sdkEntryPath = createRequire(join(packageRoot, "package.json")).resolve("@band-ai/sdk");
  return createRequire(sdkEntryPath).resolve("@band-ai/band-sdk-core");
}

export function resolveCoreWasmPath(packageRoot) {
  return join(dirname(resolveCoreEntry(packageRoot)), CORE_WASM_FILENAME);
}

export function copyWasm(
  packageRoot,
  destinationDir = join(packageRoot, "dist"),
  sourcePath = resolveCoreWasmPath(packageRoot),
) {
  assertNonEmptyWasm(sourcePath, "source wasm");
  mkdirSync(destinationDir, { recursive: true });
  const wasmDestinationPath = join(destinationDir, CORE_WASM_FILENAME);
  copyFileSync(sourcePath, wasmDestinationPath);
  assertNonEmptyWasm(wasmDestinationPath, "copied wasm");
  return wasmDestinationPath;
}
