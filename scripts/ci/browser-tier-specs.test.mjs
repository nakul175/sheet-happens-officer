// REVIEW (W96): a Chromium-driven spec has to be registered in the tier that exists for it.
//
// `vitest.browser-tier.config.mts` is not a glob: it lists its files one by one, and the default
// `vitest.config.mts` excludes each of them by name so the two tiers cannot decide each other's timing.
// A new `*.browser.test.ts` that is in neither list is collected by the default run instead — which is
// where it competes with the other files for the dev server and where, off localhost, its own
// `new URL(BASE).hostname !== "localhost"` guard throws while the suite is loading it.
//
// The contract, in one place: a file that names itself `*.browser.test.ts` is in the browser tier's
// include list and out of the default config's collection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BROWSER_CONFIG = readFileSync(join(ROOT, "vitest.browser-tier.config.mts"), "utf8");
const DEFAULT_CONFIG = readFileSync(join(ROOT, "vitest.config.mts"), "utf8");

/** The string entries of `key: [ ... ]` in a vitest config, without the spreads. */
function entriesIn(source, key) {
  const start = source.indexOf(`${key}: [`);
  assert.notEqual(start, -1, `no ${key} array in the config`);
  const body = source.slice(start + `${key}: [`.length).split("]")[0];
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Every *.browser.test.ts under tests/, as a repo-relative path with forward slashes. */
function browserSpecs(dir = join(ROOT, "tests")) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...browserSpecs(full));
    else if (entry.name.endsWith(".browser.test.ts")) out.push(relative(ROOT, full).split("\\").join("/"));
  }
  return out.sort();
}

/** True when the default config keeps this file out of `npm test`, by name or by a whole-directory pattern. */
function excludedFromDefault(file) {
  return entriesIn(DEFAULT_CONFIG, "exclude").some((entry) => {
    if (entry === file) return true;
    const dir = entry.endsWith("/**") ? entry.slice(0, -"/**".length) + "/" : null;
    return dir !== null && file.startsWith(dir);
  });
}

test("every *.browser.test.ts is collected: the file names exists and is found", () => {
  assert.ok(browserSpecs().length > 0, "no *.browser.test.ts found; the convention or the directory moved");
});

test("a *.browser.test.ts is in the browser tier's include list", () => {
  const include = entriesIn(BROWSER_CONFIG, "include");
  for (const file of browserSpecs()) {
    assert.ok(
      include.includes(file),
      `${file} drives a real Chromium but is missing from vitest.browser-tier.config.mts include, so \`npm run test:browser\` never runs it`,
    );
  }
});

test("a *.browser.test.ts is kept out of the default `npm test` collection", () => {
  for (const file of browserSpecs()) {
    assert.ok(
      excludedFromDefault(file),
      `${file} is collected by vitest.config.mts, so \`npm test\` runs a Chromium spec in the jsdom/API tier`,
    );
  }
});
