import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import projectLookup from "./scripts/project-lookup-rule.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/access.ts", "src/lib/concierge/reads.ts"],
    // project-lookup-ok requires a non-empty reason immediately before the read.
    plugins: { sho: { rules: { "project-lookup": projectLookup } } },
    rules: { "sho/project-lookup": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "deploy/**", // ops scripts run on the server with plain node
  ]),
]);

export default eslintConfig;
