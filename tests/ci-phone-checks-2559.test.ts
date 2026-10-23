// SHO-2559 (QA): automated phone checks in CI.
//
// Two tiers drive a real Chromium against a running app and are deliberately kept out of `npm test`
// (vitest.config.mts excludes them so their timing is not decided by 107 other files):
//   * the phone-size / viewport tier  - tests/viewport/**  (npm run test:viewport, vitest.viewport.config.mts)
//   * the browser tier                - 7 named files      (npm run test:browser,  vitest.browser-tier.config.mts)
//
// The viewport tier is wired into CI (phone-checks.yml on every pull request, viewport.yml for main).
// The browser tier was wired into NO workflow at all: `npm run test:browser` appeared only in package.json
// and in comments, so its 7 files could break without any check ever turning red. This file is the guard
// that makes that state fail, and it is generic over package.json so the next tier added cannot repeat it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "test-results"]);

type Tier = { script: string; config: string; files: string[]; drivesChromium: boolean };
type Workflow = { file: string; raw: string };

/** The tiers a workflow can run: every package.json `test:*` script that pins its own vitest config. */
export function readTiers(root: string = ROOT): Tier[] {
  const scripts = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const tiers: Tier[] = [];
  for (const [script, command] of Object.entries(scripts)) {
    if (!script.startsWith("test:")) continue;
    const config = /-c\s+(\S+\.mts?)\b/.exec(command)?.[1];
    if (!config) continue; // `npm test` itself: the default config, already run by ci.yml.
    const files = includeGlobs(path.join(root, config)).flatMap((pattern) => expand(pattern, root));
    tiers.push({ script, config, files, drivesChromium: files.some((file) => drivesChromium(file, root)) });
  }
  return tiers.sort((a, b) => a.script.localeCompare(b.script));
}

function includeGlobs(configPath: string): string[] {
  const match = /include:\s*\[([\s\S]*?)\]/.exec(readFileSync(configPath, "utf8"));
  if (!match) throw new Error(`${path.basename(configPath)} has no include list`);
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

/** Resolves the two shapes the tier configs use: an exact file, or `<dir>/**\/*<suffix>`. */
function expand(pattern: string, root: string = ROOT): string[] {
  if (!pattern.includes("*")) return existsSync(path.join(root, pattern)) ? [pattern] : [];
  const dir = pattern.slice(0, pattern.indexOf("*")).replace(/\/+$/, "");
  const suffix = pattern.slice(pattern.lastIndexOf("*") + 1);
  const found: string[] = [];
  walk(path.join(root, dir), root, found);
  return found.filter((file) => file.endsWith(suffix)).map((file) => path.relative(root, file));
}

function walk(dir: string, root: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (SKIP_DIRS.has(name)) continue;
    const info = statSync(full);
    if (info.isDirectory()) walk(full, root, out);
    else out.push(full);
  }
}

/** A file that starts a browser itself, rather than through a helper. */
function drivesChromium(file: string, root: string = ROOT): boolean {
  const source = readFileSync(path.join(root, file), "utf8");
  return /from\s+["']playwright-core["']|require\(\s*["']playwright-core["']\s*\)/.test(source);
}

function readWorkflows(root: string = ROOT): Workflow[] {
  const dir = path.join(root, ".github/workflows");
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((file) => ({ file, raw: readFileSync(path.join(dir, file), "utf8") }));
}

/** A workflow runs a tier when its text invokes the npm script or the pinned config, as a command. */
export function workflowRuns(workflow: Workflow, script: string, config: string): boolean {
  return new RegExp(`npm run ${script}\\b`).test(workflow.raw) || new RegExp(`vitest run -c ${config}\\b`).test(workflow.raw);
}

/**
 * Tiers that drive Chromium and are run by no workflow, each rendered as "<script> (<n> files)".
 * `exempt` drops tiers outside this ticket's scope; the caller must keep that list honest (see below).
 */
export function unwiredChromiumTiers(root: string = ROOT, exempt: Record<string, string> = {}): string[] {
  const workflows = readWorkflows(root);
  return readTiers(root)
    .filter((tier) => tier.drivesChromium && !exempt[tier.script])
    .filter((tier) => !workflows.some((workflow) => workflowRuns(workflow, tier.script, tier.config)))
    .map((tier) => `${tier.script} (${tier.files.length} files)`);
}

/** The `  <job>:` block under `jobs:`, so one job's env cannot be satisfied by its neighbour's. */
function jobBlock(workflow: Workflow, name: string): string {
  const jobsAt = workflow.raw.indexOf("\njobs:\n");
  expect(jobsAt, `${workflow.file} has a jobs: block`).toBeGreaterThan(-1);
  const body = workflow.raw.slice(jobsAt + "\njobs:\n".length);
  const start = body.search(new RegExp(`^  ${name}:$`, "m"));
  expect(start, `${workflow.file} has job ${name}`).toBeGreaterThan(-1);
  const rest = body.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The job whose steps contain `command`, by the two-space key that opens it. */
function jobOwningStep(workflow: Workflow, command: string): string {
  const jobsAt = workflow.raw.indexOf("\njobs:\n");
  const body = workflow.raw.slice(jobsAt + "\njobs:\n".length);
  for (const match of body.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)) if (jobBlock(workflow, match[1]).includes(command)) return match[1];
  return "";
}

// The variables both browser tiers read: tests/helpers.ts (TASKBOARD_URL), the Super Admin it creates itself
// (SUPER_ADMIN_EMAILS), the outbox it asserts against (EMAIL_OUTBOX_DIR), and the throw-away database.
const TIER_ENV = ["DATABASE_URL", "DIRECT_DATABASE_URL", "EMAIL_OUTBOX_DIR", "SUPER_ADMIN_EMAILS", "TASKBOARD_URL", "JOB_SECRET"];
const PRECONDITIONS = [
  ["npx prisma migrate deploy", "migrates the throw-away database"],
  ["npm run build", "builds the app the tier drives"],
  ["/api/health", "waits for the app to answer before the tier runs"],
  ["playwright-core install", "installs the Chromium the tier launches"],
] as const;

describe("SHO-2559 automated phone checks in CI", () => {
  it("the phone-size viewport tier runs on every pull request, with its preconditions (qa:TC-SHO2559-6a1d0e11@v1)", () => {
    const workflow = readWorkflows().find((w) => w.file === "phone-checks.yml");
    expect(workflow, "phone-checks.yml exists").toBeDefined();
    const raw = workflow!.raw;
    // Every pull request, not only the ones targeting main: the phone tier is the broad safety net.
    expect(raw).toMatch(/^on:\n(?:.*\n)*? {2}pull_request:/m);
    expect(raw).toMatch(/npm run test:viewport\b/);
    for (const key of TIER_ENV) expect(raw, `phone-checks.yml sets ${key}`).toMatch(new RegExp(`^\\s+${key}:`, "m"));
    for (const [needle, why] of PRECONDITIONS) expect(raw, `phone-checks.yml ${why}`).toContain(needle);
    expect(raw.includes("secrets."), "the phone tier reads no credential").toBe(false);
  });

  it("every Chromium tier in package.json is run by at least one workflow (qa:TC-SHO2559-9f2c1a44@v1)", () => {
    // tests/e2e is the one Chromium tier this ticket does not wire: both of its specs fall back to a
    // hard-coded /usr/local/bin/google-chrome when PW_CHROMIUM is unset (e2e/useGet-path-reset.spec.ts:29,
    // e2e/APL-2741-stalled-bell.spec.ts:95), so it cannot run on a GitHub runner without editing them.
    // A stated exemption, not a silent skip: the first assertion proves the exempt script really is a Chrome tier.
    const exempt: Record<string, string> = { "test:e2e": "e2e specs hard-code /usr/local/bin/google-chrome when PW_CHROMIUM is unset" };
    expect(readTiers().filter((tier) => exempt[tier.script]).map((tier) => tier.drivesChromium)).toEqual([true]);
    expect(unwiredChromiumTiers(ROOT, exempt)).toEqual([]);
  });

  it("the browser tier job carries everything the tier reads (qa:TC-SHO2559-c40b7e02@v1)", () => {
    const workflow = readWorkflows().find((w) => workflowRuns(w, "test:browser", "vitest.browser-tier.config.mts"));
    expect(workflow, "some workflow runs npm run test:browser").toBeDefined();
    const jobName = jobOwningStep(workflow!, "npm run test:browser");
    expect(jobName, `${workflow!.file} runs the browser tier inside a named job`).not.toBe("");
    const job = jobBlock(workflow!, jobName);
    for (const key of TIER_ENV) expect(job, `job ${jobName} sets ${key}`).toMatch(new RegExp(`^\\s+${key}:`, "m"));
    for (const [needle, why] of PRECONDITIONS) expect(job, `job ${jobName} ${why}`).toContain(needle);
    expect(job, "the app starts on the port TASKBOARD_URL names").toContain("-p 3100");
    // Six of the seven files fall back to a system /usr/bin/google-chrome and fail before any test when it is absent,
    // which is every ubuntu-latest runner: the job must hand them the Chromium it installed (PW_CHROMIUM).
    expect(job, `job ${jobName} exports PW_CHROMIUM`).toContain("PW_CHROMIUM=$chrome");
    expect(job, `job ${jobName} exports it to the later steps`).toContain('>> "$GITHUB_ENV"');
  });

  it("no browser-tier file is collected twice or dropped from npm test (qa:TC-SHO2559-11c9a5d7@v1)", () => {
    const browser = readTiers().find((tier) => tier.script === "test:browser");
    expect(browser, "the browser tier exists").toBeDefined();
    // The config's 7 entries must each exist; a rename would otherwise shrink the tier silently.
    expect(browser!.files).toHaveLength(7);
    const main = readFileSync(path.join(ROOT, "vitest.config.mts"), "utf8");
    const excluded = new Set([...main.matchAll(/^\s+"([^"]+)",\s*$/gm)].map((m) => m[1]));
    for (const file of browser!.files) expect(excluded.has(file), `${file} is excluded from npm test`).toBe(true);
  });

  it("the guard reports an unwired tier instead of passing silently", () => {
    // A throw-away repository holding one wired tier and one unwired one: the report must name only the second.
    const root = mkdtempSync(path.join(tmpdir(), "sho-2559-"));
    try {
      mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
      mkdirSync(path.join(root, "tests/a"), { recursive: true });
      mkdirSync(path.join(root, "tests/b"), { recursive: true });
      writeFileSync(path.join(root, "tests/a/wired.test.ts"), 'import { chromium } from "playwright-core";\n');
      writeFileSync(path.join(root, "tests/b/forgotten.test.ts"), 'import { chromium } from "playwright-core";\n');
      writeFileSync(path.join(root, "tests/b/plain.test.ts"), 'import { it } from "vitest";\n');
      writeFileSync(path.join(root, "vitest.a.config.mts"), 'export default { test: { include: ["tests/a/**/*.test.ts"] } };\n');
      writeFileSync(path.join(root, "vitest.b.config.mts"), 'export default { test: { include: ["tests/b/**/*.test.ts"] } };\n');
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run", "test:a": "vitest run -c vitest.a.config.mts", "test:b": "vitest run -c vitest.b.config.mts" } }),
      );
      writeFileSync(path.join(root, ".github/workflows/ci.yml"), "jobs:\n  a:\n    steps:\n      - run: npm run test:a\n");
      // Both files in tests/b belong to test:b, but only one drives Chromium: the count is the tier's, the verdict is the browser's.
      expect(unwiredChromiumTiers(root)).toEqual(["test:b (2 files)"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
