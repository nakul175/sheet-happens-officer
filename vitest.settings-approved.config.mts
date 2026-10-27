import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }, test: { include: ["tests/settings-activity-trash-approved.test.tsx", "tests/project-delete-ui-3047.test.tsx", "tests/project-verticals-ui-3048.test.tsx", "tests/failed-flag-views.test.tsx"], fileParallelism: false } });
