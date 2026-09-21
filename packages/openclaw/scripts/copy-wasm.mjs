/**
 * Copy band_sdk_core_bg.wasm next to the bundled plugin JS.
 *
 * The OpenClaw build inlines @band-ai/sdk (and thus band-sdk-core's JS glue)
 * into dist/, but the glue still loads the .wasm from __dirname at runtime.
 * Resolve the wasm from the same @band-ai/band-sdk-core package that
 * @band-ai/sdk depends on — not a separate OpenClaw pin — so glue and wasm
 * cannot drift.
 */

import { copyFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CORE_WASM_FILENAME = "band_sdk_core_bg.wasm";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(scriptDir);
const requireFromOpenclaw = createRequire(join(pkgRoot, "package.json"));

export function assertNonEmptyWasm(path, label) {
  const size = statSync(path).size;
  if (size === 0) {
    throw new Error(`[copy-wasm] ${label} is empty: ${path}`);
  }
}

export function resolveCoreWasmPath() {
  // Resolve through an @band-ai/sdk module file so Node uses the SDK package's
  // dependency graph (exports block "@/package.json" subpath access).
  const sdkEntryPath = requireFromOpenclaw.resolve("@band-ai/sdk");
  const requireFromSdk = createRequire(sdkEntryPath);
  const coreEntryPath = requireFromSdk.resolve("@band-ai/band-sdk-core");
  return join(dirname(coreEntryPath), CORE_WASM_FILENAME);
}

export function copyWasm(destinationDir = join(pkgRoot, "dist")) {
  const wasmSourcePath = resolveCoreWasmPath();
  assertNonEmptyWasm(wasmSourcePath, "source wasm");
  mkdirSync(destinationDir, { recursive: true });
  const wasmDestinationPath = join(destinationDir, CORE_WASM_FILENAME);
  copyFileSync(wasmSourcePath, wasmDestinationPath);
  assertNonEmptyWasm(wasmDestinationPath, "copied wasm");
  return wasmDestinationPath;
}

function isCliEntry() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isCliEntry()) {
  const dest = copyWasm();
  console.log(`[copy-wasm] wrote ${dest}`);
}
