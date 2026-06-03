// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Source: full type-aware rule set
    files: ["packages/*/src/**/*.ts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      curly: ["error", "all"],
      "@typescript-eslint/strict-boolean-expressions": ["error", {
        allowNullableBoolean: true,
        allowNullableString: true,
        allowNullableNumber: true,
      }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/array-type": ["error", { default: "array" }],
    },
  },
  {
    // Tests: not in any tsconfig → syntactic rules only (no type info, no parsing error)
    files: ["packages/*/test/**/*.ts"],
    extends: [tseslint.configs.base],
    rules: {
      curly: ["error", "all"],
      "@typescript-eslint/array-type": ["error", { default: "array" }],
    },
  },
);
