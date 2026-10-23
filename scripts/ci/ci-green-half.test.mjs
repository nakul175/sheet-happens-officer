// The "…and CI is green" half of seven AC clauses: 2917 AC2, 2951 AC3, 3000 AC3, 3010 AC4, 3011 AC4, 3012 AC4,
// 3013 AC4 (W133-REPORT.md §4.3; AC-TRUTH-TABLE-35.md). Every one of those clauses is "a test covers it, and CI is
// green", and the first half has a receipt file. Nothing asserted the second half.
//
// "CI is green" is two different claims and only one of them is a repo fact:
//
//   GREEN-CONCLUSION   the CI provider's conclusion for a head SHA is `success`. A hosted-run fact: it needs a provider
//                      token and a network call at test time, so it is NOT asserted here and cannot be faked by reading
//                      a file. W161-REPORT.md carries it as NOT-TESTABLE-IN-REPO for each of the seven.
//   WIRED              the part a repo can be wrong about, and today nobody checks: that the run called "CI" executes
//                      the very file the clause's first half names, that the step cannot fail soft, that the workflow
//                      runs at all on a pull request, and that it checks out the PR head SHA rather than a merge
//                      commit. Break any one of those and "CI is green" is true while saying nothing about the clause —
//                      which is exactly the state where the unenforced half of the AC hides.
//
// This file is itself run by `.github/workflows/ci.yml` ("Node tests for scripts/ci"), before `npm ci`, from `node:test`
// and node builtins only, so it needs no dependency and no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const DEFAULT_CONFIG = readFileSync(join(ROOT, "vitest.config.mts"), "utf8");

/** One row per clause: the ticket, the clause, its second half, and the file that enforces the first half. */
const CLAUSES = [
  { ticket: "2917", clause: "AC2", half: "…CI green", receipt: "tests/base-url-env-2917.test.ts" },
  { ticket: "2951", clause: "AC3", half: "…tests cover both, CI green", receipt: "tests/usage-month-figure-2951.test.ts" },
  { ticket: "3000", clause: "AC3", half: "CI is green", receipt: "tests/staging-local-only-list.test.ts" },
  { ticket: "3010", clause: "AC4", half: "A test covers it and CI is green.", receipt: "tests/concierge-echo.test.ts" },
  { ticket: "3011", clause: "AC4", half: "A test covers it and CI is green.", receipt: "tests/apl-2742.test.ts" },
  { ticket: "3012", clause: "AC4", half: "A test covers it and CI is green.", receipt: "tests/usage-percent-default-cap.test.ts" },
  { ticket: "3013", clause: "AC4", half: "A test covers it and CI is green.", receipt: "tests/usage-ceiling.test.tsx" },
];

/** The string entries of `key: [ ... ]` in a vitest config, without the spreads (same idiom as browser-tier-specs.test.mjs). */
function entriesIn(source, key) {
  const start = source.indexOf(`${key}: [`);
  assert.notEqual(start, -1, `no ${key} array in the config`);
  const body = source.slice(start + `${key}: [`.length).split("]")[0];
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const EXCLUDED = entriesIn(DEFAULT_CONFIG, "exclude");

/** A glob from the config (`*`, `**`) as a regex over a repo-relative path. */
function globRe(pattern) {
  const escaped = pattern
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/** The paths the default config keeps out of `npm test` that match this file, if any. */
const excludedBy = (file) => EXCLUDED.filter((pattern) => globRe(pattern).test(file));

/** Vitest's default include() for a file name that is not in a __tests__ directory. */
const DEFAULT_INCLUDE = /\.(test|spec)\.(c|m)?[jt]sx?$/;

/** A step of ci.yml, split on the step separator. */

test("the seven clauses are exactly the ones W133 §4.3 lists, one receipt each", () => {
  assert.deepEqual(
    CLAUSES.map((c) => `${c.ticket} ${c.clause}`),
    ["2917 AC2", "2951 AC3", "3000 AC3", "3010 AC4", "3011 AC4", "3012 AC4", "3013 AC4"],
  );
  for (const { ticket, receipt } of CLAUSES) {
    assert.ok(existsSync(join(ROOT, receipt)), `${ticket}: ${receipt} does not exist`);
  }
});

test("CI runs on a pull request, so the head of a branch gets a run to be green or red", () => {
  assert.match(CI, /^on:\n\s+pull_request:/m, "ci.yml must be triggered by pull_request, not only by a push to main");
});

test("CI checks out the PR head SHA, so the run is that SHA and not a merge commit", () => {
  // Without this, actions/checkout hands a pull_request workflow a synthetic merge commit, and "the CI conclusion for
  // this head SHA is success" would be a statement about a commit nobody pushed.
  assert.match(
    CI,
    /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.sha\s*\}\}/,
    "the checkout step must pin the PR head SHA",
  );
});

test("no step in ci.yml may fail soft", () => {
  assert.doesNotMatch(CI, /continue-on-error:\s*true/, "a continue-on-error step reports success for a failure");
});

test("the step that runs npm test exists and is that command", () => {
  const step = stepStartingWith("Unit tests");
  assert.match(step, /^\s+run: npm test$/m, "the Unit tests step must run `npm test`");
  assert.doesNotMatch(step, /continue-on-error/, "the unit-test step must not be allowed to fail soft");
});

for (const { ticket, clause, half, receipt } of CLAUSES) {
  test(`${ticket} ${clause} (${half}): CI green is only about this clause if npm test runs ${receipt}`, () => {
    // 1. The other half's receipt is a test file the default config collects.
    assert.match(receipt, DEFAULT_INCLUDE, `${ticket}: ${receipt} is not a name vitest's default include matches`);
    assert.deepEqual(
      excludedBy(receipt),
      [],
      `${ticket}: ${receipt} is excluded from \`npm test\`, so CI green says nothing about ${clause}`,
    );
    // 2. `npm test` is that same default config (`vitest run`, no -c), so the exclusion list above is the one CI applies.
    assert.match(
      readFileSync(join(ROOT, "package.json"), "utf8"),
      /"test":\s*"vitest run"/,
      "`npm test` must be the default-config vitest run this check reasoned about",
    );
    const step = stepStartingWith("Unit tests");
    assert.match(step, /^\s+run: npm test$/m, `${ticket}: the step that runs npm test must still exist`);
    // 3. The trigger exists at all, repeated here so a failure names this clause with the rest.
    assert.match(CI, /^on:\n\s+pull_request:/m, `${ticket}: ci.yml is not triggered by pull_request`);
  });
}

function stepStartingWith(name) {
  const steps = CI.split("\n      - ").slice(1);
  const step = steps.find((s) => s.startsWith(`name: ${name}`));
  assert.ok(step, `ci.yml has no step named "${name}"`);
  return step;
}
