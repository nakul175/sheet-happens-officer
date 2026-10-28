import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }, test: { include: ["e2e/APL-2741-stalled-bell.spec.ts"], fileParallelism: false, testTimeout: 120000, hookTimeout: 180000 } });
