// W258 (CI): a Vitest spec that Playwright ignores has to be named by a tier that runs it.
//
// tests/e2e/stories holds two kinds of `*.spec.ts`:
//   * Playwright stories - playwright.config.ts collects them;
//   * Vitest suites - playwright.config.ts puts them in testIgnore (tests/e2e/vitest-specs.cjs), because
//     Playwright fails at `import "vitest"` and then lists nothing.
//
// The second kind is invisible to Playwright by design, and vitest.config.mts excludes the whole directory
// (`"tests/e2e/stories/**"`, added by APL-2709 so the 113 story specs could not fall into `npm test`). A
// Vitest story spec that no tier config names therefore runs NOWHERE: `npm test` skips it, Playwright
// ignores it, and every offline run stays green. That is the W96 trap again, one directory further on -
// and it was live at HEAD: tests/e2e/stories/APL-2522.spec.ts was excluded from `npm test`, ignored by
// Playwright and named by no config, from the commit that added the directory exclude until this file.
//
// The invariant, stated once: every spec Playwright refuses to load for importing vitest is named by the
// include list of at least one `vitest*.config.mts`, and that config is run by an npm script or a workflow
// step. The second half is what makes "named by a tier" mean "run by something", so a config that exists
// and is invoked by nobody cannot satisfy this guard.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// The same list playwright.config.ts passes as testIgnore: one source, so the guard and the runner agree.
const { vitestSpecFiles } = require("../tests/e2e/vitest-specs.cjs") as { vitestSpecFiles: () => string[] };

const ROOT = process.cwd();
const STORIES = "tests/e2e/stories";

/** The default tier's config. `npm test` runs it with no `-c`, so its name appears in no command line. */
const DEFAULT_CONFIG = "vitest.config.mts";

/**
 * The string entries of one `key: [ ... ]` list in a vitest config, read off the text (no import side effects).
 * No `include` list means the tier runs Vitest's default include (`**\/*.{test,spec}.?`), which selects no
 * story spec once `tests/e2e/stories/**` is excluded - that is vitest.config.mts, and it names nothing here.
 */
function entries(configName: string, key: "include" | "exclude"): string[] {
  const source = readFileSync(path.join(ROOT, configName), "utf8");
  const match = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (!match) {
    if (key === "include") return [];
    throw new Error(`${configName} has no ${key} list`);
  }
  // Every quoted string, wherever it sits: vitest.crm-visible-modes.config.mts lists its six files on one line.
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);
}

/** True when a config entry selects `file`: the exact path, or a glob (`*`, `**`) that matches it. */
function selects(entry: string, file: string): boolean {
  if (entry === file) return true;
  if (!entry.includes("*")) return false;
  const rx = new RegExp(`^${entry.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
  return rx.test(file);
}

/** Every `vitest*.config.mts` in the repo root, with its include list. */
function vitestConfigs(): { name: string; include: string[] }[] {
  return readdirSync(ROOT)
    .filter((name) => /^vitest.*\.config\.mts$/.test(name))
    .sort()
    .map((name) => ({ name, include: entries(name, "include") }));
}

/** True when an npm script or a workflow `run:` line invokes this config, so naming it in a list is not enough. */
function invoked(configName: string): boolean {
  const scripts = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  if (Object.values(scripts).some((command) => command.includes(configName))) return true;
  // A config named only inside a workflow comment is not an invocation, so the needle has to be on a run: line.
  const runLine = new RegExp(`^\\s*(?:-\\s*)?run:.*${configName === DEFAULT_CONFIG ? "\\bnpm test\\b" : configName.replace(/\./g, "\\.")}`, "m");
  const workflows = path.join(ROOT, ".github/workflows");
  return readdirSync(workflows)
    .filter((name) => /\.ya?ml$/.test(name))
    .some((name) => runLine.test(readFileSync(path.join(workflows, name), "utf8")));
}

describe("W258 tier coverage: no story spec is invisible to every tier", () => {
  it("the list the guard reads is the real one, and it is not empty", () => {
    // A rename of the stories directory, or a reader that silently stops finding vitest imports, would
    // otherwise turn every assertion below into a pass over an empty set.
    expect(vitestSpecFiles().length, "some story spec imports vitest").toBeGreaterThan(0);
    expect(readdirSync(path.join(ROOT, STORIES)).filter((name) => name.endsWith(".spec.ts")).length).toBeGreaterThan(
      vitestSpecFiles().length,
    );
  });

  it("every story spec Playwright ignores is named by a tier that something runs", () => {
    const configs = vitestConfigs();
    for (const name of vitestSpecFiles()) {
      const file = `${STORIES}/${name}`;
      const owners = configs.filter((config) => config.include.some((entry) => selects(entry, file)));
      expect(
        owners.map((config) => config.name),
        `${file} imports vitest, so playwright.config.ts ignores it, and vitest.config.mts excludes ${STORIES}/**. ` +
          `No vitest*.config.mts include list names it, so no tier runs it and it can never turn red.`,
      ).not.toEqual([]);
      // Naming it in a config nobody invokes is the same defect one step later: the config exists, runs nowhere.
      expect(
        owners.filter((config) => invoked(config.name)).map((config) => config.name),
        `${file} is named by ${owners.map((c) => c.name).join(", ")}, but no npm script or workflow step runs that config`,
      ).not.toEqual([]);
    }
  });

  it("the guard reports an orphan instead of passing silently", () => {
    // Not a fixture over the real tree: the check itself is exercised on a config that names nothing.
    expect(selects("tests/e2e/stories/**", `${STORIES}/APL-2522.spec.ts`)).toBe(true);
    expect(selects("tests/e2e/stories/APL-2736.spec.ts", `${STORIES}/APL-2522.spec.ts`)).toBe(false);
    expect(selects(`${STORIES}/*.spec.ts`, `${STORIES}/APL-2522.spec.ts`)).toBe(true);
  });
});
