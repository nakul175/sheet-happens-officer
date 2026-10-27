// APL-2761: Playwright loads every file under tests/e2e/stories before it runs one. A file that imports vitest,
// directly or through a local helper (tests/helpers.ts does), fails to load and the whole run collects 0 tests.
// Vitest suites that drive a local server belong in tests/e2e/local.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The same list playwright.config.ts passes as testIgnore (APL-2879), and the same comment- and string-aware reader (APL-2892).
import { VITEST_SPECS, codeAndStrings, moduleSpecifiers, vitestSpecFiles } from "../../tests/e2e/vitest-specs.cjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STORIES = join(ROOT, "tests/e2e/stories");
const EXTS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts"];

/** Every module specifier in a file, type-only imports included (they are erased, but they never need vitest either). */
export function specifiers(source) {
  return moduleSpecifiers(source);
}

function resolveLocal(from, spec) {
  let base;
  if (spec.startsWith("./") || spec.startsWith("../")) base = resolve(dirname(from), spec);
  else if (spec.startsWith("@/")) base = join(ROOT, "src", spec.slice(2));
  else return null;
  for (const ext of EXTS) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/** The chain of files from `file` to a vitest import, or null when there is none. */
export function vitestChain(file, seen = new Set()) {
  if (seen.has(file)) return null;
  seen.add(file);
  for (const spec of specifiers(readFileSync(file, "utf8"))) {
    if (spec === "vitest" || spec.startsWith("vitest/")) return [file];
    const next = resolveLocal(file, spec);
    if (!next || next.startsWith(join(ROOT, "src", "generated"))) continue;
    const chain = vitestChain(next, seen);
    if (chain) return [file, ...chain];
  }
  return null;
}

test("qa:TC TC-SHO2904-01 specifiers finds static, dynamic, side-effect and require imports", () => {
  const src = [
    'import { a } from "vitest";',
    'import type { B } from "../../helpers";',
    'import "./side";',
    'const c = await import("./lazy");',
    'const d = require("vitest/config");',
  ].join("\n");
  assert.deepEqual(specifiers(src), ["vitest", "../../helpers", "./side", "./lazy", "vitest/config"]);
});
/** File names in the testIgnore list playwright.config.ts resolves (entries are "**\/stories/<name>"): Playwright never loads them. */
export function ignoredByPlaywright(patterns = VITEST_SPECS) {
  return new Set(patterns.map((p) => basename(p)));
}

/** Spec files in `dir` that Playwright loads (not ignored) and that reach vitest, each as its import chain. */
function loadedSpecsReachingVitest(dir, ignored) {
  const files = readdirSync(dir).filter((f) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(f) && !ignored.has(f));
  assert.ok(files.length > 0, `${relative(ROOT, dir) || dir} has no spec files`);
  const bad = [];
  for (const f of files) {
    const chain = vitestChain(join(dir, f));
    if (chain) bad.push(chain.map((p) => relative(ROOT, p)).join(" -> ") + " -> vitest");
  }
  return bad;
}

test("qa:TC TC-SHO2904-02 the guard still catches a loaded story spec that reaches vitest through a helper", () => {
  const dir = mkdtempSync(join(tmpdir(), "story-specs-"));
  try {
    writeFileSync(join(dir, "APL-1.spec.ts"), 'import { it } from "vitest";\n');
    writeFileSync(join(dir, "helper.ts"), 'import { expect } from "vitest";\nexport const x = expect;\n');
    writeFileSync(join(dir, "APL-2.spec.ts"), 'import { x } from "./helper";\n');
    writeFileSync(join(dir, "APL-3.spec.ts"), 'import { test } from "@playwright/test";\n');
    const ignored = ignoredByPlaywright(vitestSpecFiles(dir).map((f) => `**/stories/${f}`));
    assert.deepEqual([...ignored], ["APL-1.spec.ts"]);
    const bad = loadedSpecsReachingVitest(dir, ignored);
    assert.equal(bad.length, 1, bad.join("\n"));
    assert.match(bad[0], /APL-2\.spec\.ts -> .*helper\.ts -> vitest$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("qa:TC TC-SHO2904-03 no story spec Playwright loads from tests/e2e/stories reaches vitest", () => {
  const bad = loadedSpecsReachingVitest(STORIES, ignoredByPlaywright());
  assert.deepEqual(bad, [], `Playwright would collect 0 tests. Move Vitest suites to tests/e2e/local:\n${bad.join("\n")}`);
});

// APL-2892 D3: a Playwright spec that only mentions `from "vitest"` in a comment, a string or a regex is not a Vitest spec.
const MENTIONS_ONLY = [
  "// Mentions vitest only in prose and data: this is a Playwright spec.",
  '/* import { it } from "vitest"; */',
  'import { test, expect } from "@playwright/test";',
  "const note = 'moved away from \"vitest\"';",
  "const tpl = `was: import { it } from 'vitest'`;",
  "const re = /from\\s+[\"']vitest[\"']/;",
  'test("ZZ-TEST mention", () => { expect(re.test(note)).toBe(true); expect(tpl).toContain("vitest"); });',
].join("\n");

test("qa:TC TC-SHO2904-04 D3: a spec with from \"vitest\" only in a comment, string or regex is not a Vitest spec", () => {
  assert.deepEqual(specifiers(MENTIONS_ONLY), ["@playwright/test"]);
  const dir = mkdtempSync(join(tmpdir(), "story-specs-"));
  try {
    writeFileSync(join(dir, "APL-1.spec.ts"), 'import { it } from "vitest";\n');
    writeFileSync(join(dir, "APL-4.spec.ts"), MENTIONS_ONLY);
    const ignored = ignoredByPlaywright(vitestSpecFiles(dir).map((f) => `**/stories/${f}`));
    assert.deepEqual([...ignored], ["APL-1.spec.ts"]);
    assert.deepEqual(loadedSpecsReachingVitest(dir, ignored), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// APL-2892 AC3: every real `import ... from "vitest"` form is still a Vitest spec.
test("qa:TC TC-SHO2904-05 AC3: a spec with a real import ... from \"vitest\" is still a Vitest spec", () => {
  const dir = mkdtempSync(join(tmpdir(), "story-specs-"));
  try {
    writeFileSync(join(dir, "APL-1.spec.ts"), 'import { it } from "vitest";\n');
    writeFileSync(join(dir, "APL-2.spec.ts"), "// header\nimport {\n  afterAll,\n  it,\n} from 'vitest';\n");
    writeFileSync(join(dir, "APL-3.spec.ts"), 'import { test } from "@playwright/test";\nimport type { Mock } from "vitest";\n');
    writeFileSync(join(dir, "APL-5.spec.ts"), 'import { test } from "@playwright/test";\n');
    assert.deepEqual(vitestSpecFiles(dir).sort(), ["APL-1.spec.ts", "APL-2.spec.ts", "APL-3.spec.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CONFIG = join(ROOT, "playwright.config.ts");

/** APL-2892 D2: playwright.config.ts imports VITEST_SPECS from tests/e2e/vitest-specs.cjs and passes it to testIgnore. */
export function assertConfigAppliesVitestSpecs(file = CONFIG) {
  const { code, strings } = codeAndStrings(readFileSync(file, "utf8"));
  const imported = [...code.matchAll(/\bimport\s*\{[^}]*\bVITEST_SPECS\b[^}]*\}\s*from\s*"#(\d+)"/g)].some((m) =>
    /\/vitest-specs(?:\.cjs)?$/.test(strings[Number(m[1])]),
  );
  const applied = /\btestIgnore\s*:\s*(?:\[[^\]]*\.\.\.\s*)?VITEST_SPECS\b/.test(code);
  assert.ok(
    imported && applied,
    `${relative(ROOT, file)} must import VITEST_SPECS from tests/e2e/vitest-specs.cjs and pass it to testIgnore, ` +
      "or Playwright loads the Vitest story specs and collects 0 tests.",
  );
}

test("qa:TC TC-SHO2904-06 D2: playwright.config.ts applies VITEST_SPECS to testIgnore", () => {
  assertConfigAppliesVitestSpecs();
});

test("qa:TC TC-SHO2904-07 D2: the config check fails naming playwright.config.ts when testIgnore drops VITEST_SPECS", () => {
  const real = readFileSync(CONFIG, "utf8");
  assert.match(real, /testIgnore: VITEST_SPECS,/);
  const dir = mkdtempSync(join(tmpdir(), "pw-config-"));
  const copy = join(dir, "playwright.config.ts");
  const check = (src) => {
    writeFileSync(copy, src);
    return () => assertConfigAppliesVitestSpecs(copy);
  };
  try {
    assert.doesNotThrow(check(real.replace("testIgnore: VITEST_SPECS,", 'testIgnore: [...VITEST_SPECS, "**/x.spec.ts"],')));
    for (const bad of [
      real.replace("testIgnore: VITEST_SPECS,", "testIgnore: [],"),
      real.replace("testIgnore: VITEST_SPECS,", ""),
      real.replace("testIgnore: VITEST_SPECS,", "// testIgnore: VITEST_SPECS,"),
      real.replace(/^import \{ VITEST_SPECS \}.*$/m, 'const VITEST_SPECS = []; // was: import { VITEST_SPECS } from "./tests/e2e/vitest-specs.cjs";'),
    ]) {
      assert.notEqual(bad, real);
      assert.throws(check(bad), /playwright\.config\.ts must import VITEST_SPECS/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// SHO-2904 owns stable ids for every guard in this file. Keep the sequential suffixes unique when adding a test.
const SELF = fileURLToPath(import.meta.url);

/** Every `test("<title>", ...)` title in `source`, read as code so a title quoted in a comment or string is not one. */
export function testTitles(source) {
  const { code, strings } = codeAndStrings(source);
  return [...code.matchAll(/\btest\(\s*"#(\d+)"/g)].map((m) => strings[Number(m[1])]);
}

/** The stable SHO-2904 id at the start of each test title. */
const QA_TITLE = /\bqa:TC (TC-SHO2904-[A-Za-z0-9]+)\b/;

test("qa:TC TC-SHO2904-08 every title in this file has a unique stable SHO-2904 id", () => {
  const titles = testTitles(readFileSync(SELF, "utf8"));
  assert.ok(titles.length >= 8, `read ${titles.length} titles from ${relative(ROOT, SELF)}, so the reader found no tests`);
  const ids = titles.map((title) => title.match(QA_TITLE)?.[1]);
  assert.deepEqual(ids.filter(Boolean).length, titles.length, `Every title must start with a qa:TC TC-SHO2904-<suffix> id:\n${titles.join("\n")}`);
  assert.equal(new Set(ids).size, ids.length, `qa:TC ids must be unique:\n${ids.join("\n")}`);
});
