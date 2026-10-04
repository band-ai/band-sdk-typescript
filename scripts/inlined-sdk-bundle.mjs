import { copyWasm, CORE_WASM_FILENAME } from "./copy-wasm.mjs";

/**
 * tsup options for a plugin that inlines @band-ai/sdk: the band-sdk-core glue reads
 * __dirname, bundled CJS deps call require(), and the wasm must sit beside the JS.
 */
export const inlinedSdkBundleOptions = {
  shims: true,
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
  // clean: true wipes dist/ on every build and watch rebuild, and a JS-only dist can't load.
  async onSuccess() {
    try {
      copyWasm(process.cwd());
    } catch (error) {
      console.error(`[copy-wasm] failed to restore ${CORE_WASM_FILENAME} after build:`, error);
      process.exit(1);
    }
  },
};
