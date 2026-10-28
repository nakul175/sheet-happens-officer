import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The Linux tier for the SIGTERM drain work (APL-2688 / APL-2689). Its files can only pass on Linux,
// so they are named out of `npm test` in vitest.config.mts and named in here:
//   * tests/shutdown-next.test.ts spawns `taskset`, reads /proc/<pid>/*, and runs `next build`, which
//     would rewrite .next under a server the job already started;
//   * the seven SIGTERM-drain tests in tests/shutdown.test.ts expect exit 0 and the clean-drain line,
//     which need the accept-queue seizer that src/lib/shutdown.ts loads on linux only.
// ci.yml runs this config on ubuntu-latest ("SIGTERM drain tests", before "Start the app").
// tests/tier-placement.test.ts asserts that placement, so neither file can drop out of every tier.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    testTimeout: 30000,
    fileParallelism: false,
    include: [
      // One exact file per line: the guard in tests/tier-placement.test.ts reads this list by line.
      "tests/shutdown.test.ts",
      "tests/shutdown-next.test.ts",
    ],
  },
});
