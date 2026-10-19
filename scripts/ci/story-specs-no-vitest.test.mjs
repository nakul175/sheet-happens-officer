// APL-2761: Playwright loads every file under tests/e2e/stories before it runs one. A file that imports vitest,
// directly or through a local helper (tests/helpers.ts does), fails to load and the whole run collects 0 tests.
// Vitest suites that drive a local server belong in tests/e2e/local.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The same list playwright.config.ts passes as testIgnore (APL-2879).
import { VITEST_SPECS, vitestSpecFiles } from "../../tests/e2e/vitest-specs.cjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STORIES = join(ROOT, "tests/e2e/stories");
const EXTS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts"];

const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

/** Every module specifier in a file, type-only imports included (they are erased, but they never need vitest either). */
export function specifiers(source) {
  return [...source.matchAll(SPECIFIERS)].map((m) => m[1]);
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

test("specifiers finds static, dynamic, side-effect and require imports qa:TC missing", () => {
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

test("the guard still catches a loaded story spec that reaches vitest through a helper qa:TC missing", () => {
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

test("no story spec Playwright loads from tests/e2e/stories reaches vitest qa:TC missing", () => {
  const bad = loadedSpecsReachingVitest(STORIES, ignoredByPlaywright());
  assert.deepEqual(bad, [], `Playwright would collect 0 tests. Move Vitest suites to tests/e2e/local:\n${bad.join("\n")}`);
});
