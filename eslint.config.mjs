import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import projectLookup from "./eslint/no-unguarded-project-lookup.mjs";

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
  ]),
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { sho: { rules: { "no-unguarded-project-lookup": projectLookup } } },
    rules: { "sho/no-unguarded-project-lookup": "error" },
  },
]);

export default eslintConfig;
