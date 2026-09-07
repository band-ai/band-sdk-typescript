import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@band-ai/sdk/realtime": path.resolve(__dirname, "src/realtime/index.ts"),
    },
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reportsDirectory: "./coverage",
      tempDirectory: "./.vitest-coverage-tmp",
      reporter: ["text"],
    },
  },
});
