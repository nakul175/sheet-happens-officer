// APL-2761: Playwright loads every file under tests/e2e/stories before it runs one. A file that imports vitest,
// directly or through a local helper (tests/helpers.ts does), fails to load and the whole run collects 0 tests.
// Vitest suites that drive a local server belong in tests/e2e/local.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

test("specifiers finds static, dynamic, side-effect and require imports", () => {
  const src = [
    'import { a } from "vitest";',
    'import type { B } from "../../helpers";',
    'import "./side";',
    'const c = await import("./lazy");',
    'const d = require("vitest/config");',
  ].join("\n");
  assert.deepEqual(specifiers(src), ["vitest", "../../helpers", "./side", "./lazy", "vitest/config"]);
});

test("no story spec under tests/e2e/stories reaches vitest", () => {
  const files = readdirSync(STORIES).filter((f) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(f));
  assert.ok(files.length > 0, "tests/e2e/stories has no spec files");
  const bad = [];
  for (const f of files) {
    const chain = vitestChain(join(STORIES, f));
    if (chain) bad.push(chain.map((p) => relative(ROOT, p)).join(" -> ") + " -> vitest");
  }
  assert.deepEqual(bad, [], `Playwright would collect 0 tests. Move Vitest suites to tests/e2e/local:\n${bad.join("\n")}`);
});
