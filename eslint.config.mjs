// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts"],
  extends: [tseslint.configs.base],
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
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
});
