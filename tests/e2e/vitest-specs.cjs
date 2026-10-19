// Story specs that are Vitest files (`npm test` runs them) share tests/e2e/stories with the Playwright ones. Playwright
// fails at `import "vitest"` when it loads one and then lists nothing, so playwright.config.ts ignores every spec that
// imports vitest. scripts/ci/story-specs-no-vitest.test.mjs reads the same list. Plain CommonJS with no dependencies:
// Playwright loads the config as CommonJS, and CI runs that guard before `npm ci` (APL-2879, APL-2761).
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose, see above */
const { readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");

const STORIES = path.join(__dirname, "stories");

/** File names of the *.spec.ts files in `dir` that import vitest themselves. */
function vitestSpecFiles(dir = STORIES) {
  return readdirSync(dir).filter((f) => f.endsWith(".spec.ts") && /from\s+["']vitest["']/.test(readFileSync(path.join(dir, f), "utf8")));
}

/** playwright.config.ts testIgnore. Found by reading the files, so a new Vitest story never breaks `--list`. */
const VITEST_SPECS = vitestSpecFiles().map((f) => `**/stories/${f}`);

module.exports = { STORIES, vitestSpecFiles, VITEST_SPECS };
