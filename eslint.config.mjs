import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "deploy/**", // ops scripts run on the server with plain node
    // Story specs are Playwright. This branch's harness is not a unit-test project, and eslint
    // already errors on it (explicit any). They run from the staging workflow.
    "tests/e2e/**",
  ]),
  // Story specs run under Playwright, not the Next app. They use `any` for JSON
  // fixtures and a callback named `use`, which the React hooks rule misreads.
  {
    files: ["tests/e2e/**/*.{ts,tsx}", "playwright.config.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "off",
      "react-hooks/rules-of-hooks": "off",
    },
  },
]);

export default eslintConfig;
