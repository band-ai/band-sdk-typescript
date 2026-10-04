import { defineConfig } from "tsup";

import { inlinedSdkBundleOptions } from "../../scripts/copy-wasm.mjs";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  // Claude Code runs the plugin from its installed files without installing dependencies, so dist/ carries everything.
  noExternal: ["@band-ai/sdk"],
  // Reached only through SDK code paths this plugin never runs.
  external: ["express", "@anthropic-ai/claude-agent-sdk"],
  ...inlinedSdkBundleOptions,
});
