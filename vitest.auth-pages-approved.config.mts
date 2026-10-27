import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }, test: { include: ["tests/auth-pages-approved.test.tsx", "tests/signin-approved.test.tsx", "tests/scoped4-central-signin.test.tsx"], fileParallelism: false } });
