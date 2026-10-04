import tseslint from "@typescript-eslint/eslint-plugin";

import { relaxedRules, strictTypeCheckedRules } from "../../packages/sdk/eslint.config.js";

const STRICT_TS_FILES = ["src/**/*.ts"];
const RELAXED_TS_FILES = ["tests/**/*.ts"];

export default [
  {
    ignores: ["dist/**", "node_modules/**", "*.config.*"],
  },
  ...tseslint.configs["flat/recommended"],
  {
    files: STRICT_TS_FILES,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...strictTypeCheckedRules,
      // stdout is the MCP pipe: a console line that lands there corrupts the protocol.
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: RELAXED_TS_FILES,
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: relaxedRules,
  },
];
