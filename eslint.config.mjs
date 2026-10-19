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
    "tests/e2e/**", // Playwright story specs: their fixtures are not React hooks and the API replies are untyped JSON
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
