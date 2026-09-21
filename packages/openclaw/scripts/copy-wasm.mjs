/**
 * Copy band_sdk_core_bg.wasm next to the bundled plugin JS.
 *
 * The OpenClaw build inlines @band-ai/sdk (and thus band-sdk-core's JS glue)
 * into dist/, but the glue still loads the .wasm from __dirname at runtime.
 * Resolve the wasm from the same @band-ai/band-sdk-core package that
 * @band-ai/sdk depends on — not a separate OpenClaw pin — so glue and wasm
 * cannot drift.
 */

import { copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(scriptDir);
const requireFromOpenclaw = createRequire(join(pkgRoot, "package.json"));

export function resolveCoreWasmPath() {
  // Resolve through an @band-ai/sdk module file so Node uses the SDK package's
  // dependency graph (exports block "@/package.json" subpath access).
  const sdkEntryPath = requireFromOpenclaw.resolve("@band-ai/sdk");
  const requireFromSdk = createRequire(sdkEntryPath);
  const coreEntryPath = requireFromSdk.resolve("@band-ai/band-sdk-core");
  return join(dirname(coreEntryPath), "band_sdk_core_bg.wasm");
}

export function copyWasm(destinationDir = join(pkgRoot, "dist")) {
  const wasmSourcePath = resolveCoreWasmPath();
  mkdirSync(destinationDir, { recursive: true });
  const wasmDestinationPath = join(destinationDir, "band_sdk_core_bg.wasm");
  copyFileSync(wasmSourcePath, wasmDestinationPath);
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
