import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }, test: { include: ["tests/remainder-approved.test.tsx", "tests/set-own-password-401.test.tsx", "tests/project-list-approved-ui.test.tsx", "tests/workspace-task-person-ui.test.tsx"], fileParallelism: false } });
