import tseslint from "@typescript-eslint/eslint-plugin";

const STRICT_TS_FILES = ["src/**/*.ts"];
const RELAXED_TS_FILES = ["tests/**/*.ts", "examples/**/*.ts", "src/testing/**/*.ts"];

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

const noRawNoopLoggerFallback = {
  "no-restricted-syntax": [
    "error",
    {
      selector: "LogicalExpression[operator='??'] > NewExpression[callee.name='NoopLogger']",
      message: "Use resolveLogger() for optional caller-supplied loggers.",
    },
  ],
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
    ignores: ["dist/**", "node_modules/**", "tests/integration/**", "*.config.*", "scripts/**"],
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
    files: STRICT_TS_FILES,
    ignores: ["src/core/logger.ts"],
    rules: noRawNoopLoggerFallback,
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
