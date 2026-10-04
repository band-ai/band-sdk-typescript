import { defineConfig } from "tsup";

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
  // The band-sdk-core wasm loader reads __dirname and calls require("fs").
  shims: true,
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
  async onSuccess() {
    const { copyWasm } = await import("../../scripts/copy-wasm.mjs");
    copyWasm(process.cwd());
  },
});
