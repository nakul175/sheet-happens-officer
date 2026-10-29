import {defineConfig} from "vitest/config";
import {fileURLToPath} from "node:url";
// Runs against the production-built local CI/isolated staging app, with owned API fixtures.
export default defineConfig({resolve:{alias:{"@":fileURLToPath(new URL("./src",import.meta.url))}},test:{include:["tests/deal-filter-browser.story.ts"],testTimeout:120000,hookTimeout:180000,fileParallelism:false}});
