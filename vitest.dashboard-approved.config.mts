import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }, test: { include: ["tests/review-queue-approved.test.tsx", "tests/sho-3042-opportunity-reporting.test.tsx", "tests/review-commercial-counts.test.tsx", "tests/dashboard-ui-approved.test.tsx"], fileParallelism: false } });
