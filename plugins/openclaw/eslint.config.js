import tseslint from "@typescript-eslint/eslint-plugin";

const STRICT_TS_FILES = ["src/**/*.ts"];
const RELAXED_TS_FILES = ["tests/**/*.ts"];

const strictTypeCheckedRules = {
  ...tseslint.configs["recommended-type-checked"].rules,
  "@typescript-eslint/no-unused-vars": [
    "warn",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
  "@typescript-eslint/no-explicit-any": "warn",
  "@typescript-eslint/no-empty-object-type": "off",
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/no-unsafe-assignment": "warn",
  "@typescript-eslint/no-unsafe-member-access": "warn",
  "@typescript-eslint/no-unsafe-call": "warn",
  "@typescript-eslint/no-unsafe-return": "warn",
  "@typescript-eslint/no-unnecessary-type-assertion": "error",
  "@typescript-eslint/no-base-to-string": "off",
  "@typescript-eslint/require-await": "off",
  "@typescript-eslint/unbound-method": "off",
  "no-console": ["warn", { allow: ["warn", "error", "log"] }],
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
  "no-console": ["warn", { allow: ["warn", "error", "log"] }],
};

export default [
  {
    ignores: ["dist/**", "node_modules/**", "tests/e2e/**", "tests/integration/**", "*.config.*"],
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
];
