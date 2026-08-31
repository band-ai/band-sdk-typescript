import tseslint from "@typescript-eslint/eslint-plugin";

import { requireJsdocOnExports } from "./eslint-rules/require-jsdoc-on-exports.js";

const STRICT_TS_FILES = ["src/**/*.ts"];
const RELAXED_TS_FILES = ["tests/**/*.ts", "examples/**/*.ts", "src/testing/**/*.ts"];

// Files whose exported classes are reachable from `@band-ai/sdk` or `@band-ai/sdk/adapters`,
// so a consumer meets them without ever opening the source.
const DOCUMENTED_CLASS_FILES = [
  "src/adapters/**/*.ts",
  "src/agent/**/*.ts",
  "src/core/**/*.ts",
  "src/platform/BandLink.ts",
  "src/platform/streaming/disconnectReason.ts",
  "src/runtime/preprocessing/DefaultPreprocessor.ts",
  "src/runtime/rooms/AgentRuntime.ts",
  "src/runtime/tools/customTools.ts",
  "src/runtime/types.ts",
];

// Declarations named in the public docs that are not classes: the tool-surface protocols,
// the config objects, and the custom-tool definition.
const DOCUMENTED_TYPE_FILES = [
  "src/contracts/protocols.ts",
  "src/core/logger.ts",
  "src/runtime/callbacks.ts",
  "src/runtime/tools/customTools.ts",
  "src/runtime/types.ts",
];

// Registered under three names on purpose: ESLint replaces a rule's options when a later
// config block names the same rule, so three overlapping file groups need three keys.
const jsdocPlugin = {
  rules: {
    "jsdoc-on-exported-classes": requireJsdocOnExports,
    "jsdoc-on-adapter-options": requireJsdocOnExports,
    "jsdoc-on-public-types": requireJsdocOnExports,
  },
};

const strictTypeCheckedRules = {
  ...tseslint.configs["recommended-type-checked"].rules,
  "@typescript-eslint/no-unused-vars": [
    "warn",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-empty-object-type": "off",
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-unnecessary-type-assertion": "error",
  "@typescript-eslint/no-base-to-string": "off",
  "@typescript-eslint/require-await": "off",
  "no-console": ["warn", { allow: ["warn", "error"] }],
};

const relaxedRules = {
  ...tseslint.configs["recommended"].rules,
  "@typescript-eslint/no-unused-vars": [
    "warn",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
  "@typescript-eslint/no-explicit-any": "warn",
  "@typescript-eslint/no-base-to-string": "off",
  "@typescript-eslint/require-await": "off",
  "@typescript-eslint/no-unsafe-assignment": "off",
  "@typescript-eslint/no-unsafe-member-access": "off",
  "@typescript-eslint/no-unsafe-call": "off",
  "@typescript-eslint/no-unsafe-return": "off",
  "@typescript-eslint/no-unsafe-argument": "off",
  "no-console": ["warn", { allow: ["warn", "error"] }],
};

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "tests/integration/**",
      "*.config.*",
      "scripts/**",
      "eslint-rules/**",
    ],
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
    rules: strictTypeCheckedRules,
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
  {
    // Library code throws from the typed hierarchy in src/core/errors.ts so consumers can
    // catch by class instead of matching on message text. Last in the list so it applies
    // to every src file, including the ones the relaxed block above also matches.
    //
    // PlatformRuntime.ts is excluded because another in-flight ticket owns that file's
    // lifecycle rework, including its one remaining bare throw. Converting it here would
    // collide with that change; remove this exclusion once that work lands.
    files: STRICT_TS_FILES,
    ignores: ["src/runtime/PlatformRuntime.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'ThrowStatement NewExpression[callee.name="Error"]',
          message:
            "Throw a typed error from src/core/errors.ts (BandSdkError, ValidationError, RuntimeStateError, UnsupportedFeatureError, TransportError) instead of a bare Error.",
        },
      ],
    },
  },
  {
    // Documentation guards. New public exports cannot land undocumented.
    files: DOCUMENTED_CLASS_FILES,
    plugins: { band: jsdocPlugin },
    rules: {
      "band/jsdoc-on-exported-classes": ["error", { targets: ["class"] }],
    },
  },
  {
    // Adapter option/config bags are the first thing a consumer configures, wherever they
    // are declared.
    files: STRICT_TS_FILES,
    plugins: { band: jsdocPlugin },
    rules: {
      "band/jsdoc-on-adapter-options": [
        "error",
        { targets: ["interface", "type"], namePattern: "(AdapterOptions|AdapterConfig)$" },
      ],
    },
  },
  {
    files: DOCUMENTED_TYPE_FILES,
    plugins: { band: jsdocPlugin },
    rules: {
      "band/jsdoc-on-public-types": ["error", { targets: ["interface", "type"] }],
    },
  },
];
