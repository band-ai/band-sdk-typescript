import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
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
