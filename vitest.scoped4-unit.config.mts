import {defineConfig} from "vitest/config";
import {fileURLToPath} from "node:url";
export default defineConfig({resolve:{alias:{"@":fileURLToPath(new URL("./src",import.meta.url))}},test:{include:["tests/scoped4-central-signin.test.tsx","tests/return-to.test.ts","tests/set-own-password-401.test.tsx","tests/failed-flag-views.test.tsx"],fileParallelism:false}});
