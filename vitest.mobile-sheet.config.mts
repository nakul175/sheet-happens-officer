import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({resolve:{alias:{"@":fileURLToPath(new URL("./src",import.meta.url))}},test:{include:["tests/task-sheet-history-2616.test.ts","tests/overlay-history-2616.test.ts","tests/overlay-popstate-2616.test.ts","tests/task-details-approved-ui.test.tsx","tests/modal-focus-return.test.tsx"],fileParallelism:false}});
