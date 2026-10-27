import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }, test: { include: ["tests/accounts-overview-approved.test.tsx", "tests/reported-delete-org-edit.test.tsx"], fileParallelism: false } });
