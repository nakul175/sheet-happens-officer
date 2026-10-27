import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }, test: { include: ["tests/project-list-approved-ui.test.tsx", "tests/new-project-approved-ui.test.tsx", "tests/projects-approved-ui.test.tsx", "tests/project-verticals-3048.test.ts", "tests/project-verticals-ui-3048.test.tsx", "tests/project-delete-3047.test.ts", "tests/project-delete-ui-3047.test.tsx"], fileParallelism: false } });
