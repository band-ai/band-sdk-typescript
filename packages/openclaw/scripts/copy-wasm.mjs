import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const coreEntryPath = fileURLToPath(import.meta.resolve("@band-ai/band-sdk-core"));
const wasmSourcePath = join(dirname(coreEntryPath), "band_sdk_core_bg.wasm");
const wasmDestinationUrl = new URL("../dist/band_sdk_core_bg.wasm", import.meta.url);

copyFileSync(wasmSourcePath, wasmDestinationUrl);
