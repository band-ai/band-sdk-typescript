import { defineConfig } from "tsup";

import { inlinedSdkBundleOptions } from "../../scripts/inlined-sdk-bundle.mjs";

export default defineConfig({
  entry: ["src/server.ts", "src/agents.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  // Claude Code runs the plugin from its installed files without installing dependencies, so dist/ carries everything.
  noExternal: ["@band-ai/sdk"],
  // Reached only through SDK code paths this plugin never runs.
  // sqlite: the SDK's journal lock lazy-loads node:sqlite; esbuild does not know
  // the built-in, so it stays external for Node to resolve.
  external: ["express", "@anthropic-ai/claude-agent-sdk", "node:sqlite", "sqlite"],
  ...inlinedSdkBundleOptions,
});
