import tseslint from "typescript-eslint";

/**
 * This package is headless — no React, so no rules-of-hooks plugin. What is
 * worth linting here is the TypeScript itself, since the whole package is
 * arithmetic and a silently-any value is how a wrong number gets shipped.
 */
export default [
  // MUST be its own object with no `files` key. An `ignores` alongside `files`
  // only filters THAT config block — it does not stop ESLint walking the tree.
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/*.d.ts"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
