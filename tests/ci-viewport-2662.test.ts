// APL-2662: CI runs the viewport tests in Playwright Chromium.
// One test per approved Gherkin scenario (Michael, v1).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = path.join(process.cwd(), ".github/workflows/viewport.yml");
const FAILING_NAME = "deliberately failing viewport test";

type YMap = { [key: string]: YNode };
type YNode = string | number | boolean | null | YNode[] | YMap;

function isMap(node: YNode | undefined): node is YMap {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

/** Reads the subset of YAML this workflow uses: maps, lists, scalars, and `|` blocks. */
function parseYaml(src: string): YNode {
  const lines = src.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });
  let index = 0;

  function parseBlock(minIndent: number): string {
    const chunks: string[] = [];
    while (index < lines.length && indentOf(lines[index]) >= minIndent) {
      chunks.push(lines[index].slice(minIndent));
      index++;
    }
    return chunks.join("\n").trim();
  }

  function parseValue(indent: number): YNode {
    if (index >= lines.length || indentOf(lines[index]) < indent) return "";
    const body = lines[index].slice(indent);
    if (body.startsWith("- ")) return parseList(indent);
    return parseMap(indent);
  }

  function parseList(indent: number): YNode[] {
    const items: YNode[] = [];
    while (index < lines.length && indentOf(lines[index]) === indent && lines[index].slice(indent).startsWith("- ")) {
      const body = lines[index].slice(indent + 2);
      index++;
      const split = splitKey(body);
      if (!split) {
        items.push(parseScalar(body));
        continue;
      }
      const item: YMap = {};
      const [key, rest] = split;
      item[key] = rest === "" ? parseValue(indentOf(lines[index])) : takeScalar(rest, indent);
      const nested = indent + 2;
      while (index < lines.length && indentOf(lines[index]) === nested && !lines[index].slice(nested).startsWith("- ")) {
        const [childKey, childRest] = mustSplit(lines[index].slice(nested));
        index++;
        item[childKey] = childRest === "" ? parseValue(indentOf(lines[index])) : takeScalar(childRest, nested);
      }
      items.push(item);
    }
    return items;
  }

  function parseMap(indent: number): YMap {
    const map: YMap = {};
    while (index < lines.length && indentOf(lines[index]) === indent && !lines[index].slice(indent).startsWith("- ")) {
      const [key, rest] = mustSplit(lines[index].slice(indent));
      index++;
      map[key] = rest === "" ? parseValue(indentOf(lines[index])) : takeScalar(rest, indent);
    }
    return map;
  }

  function takeScalar(rest: string, keyIndent: number): YNode {
    if (rest === "|" || rest === "|-" || rest === "|+") {
      if (index >= lines.length) return "";
      return parseBlock(indentOf(lines[index]) > keyIndent ? indentOf(lines[index]) : keyIndent + 1);
    }
    return parseScalar(rest);
  }

  return parseMap(0);
}

function indentOf(line: string): number {
  let count = 0;
  while (line[count] === " ") count++;
  return count;
}

function splitKey(text: string): [string, string] | null {
  const match = /^([^:'"]+):\s*(.*)$/.exec(text);
  return match ? [match[1], match[2]] : null;
}

function mustSplit(text: string): [string, string] {
  const split = splitKey(text);
  if (!split) throw new Error(`Cannot read YAML line: ${text}`);
  return split;
}

function parseScalar(raw: string): YNode {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function stringsIn(node: YNode): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(stringsIn);
  if (isMap(node)) return Object.values(node).flatMap(stringsIn);
  return [];
}

function loadWorkflow(): { raw: string; doc: YMap; job: YMap; steps: YMap[] } {
  const raw = readFileSync(WORKFLOW_PATH, "utf8");
  const parsed = parseYaml(raw);
  if (!isMap(parsed)) throw new Error("viewport workflow root is not a map");
  const jobs = parsed.jobs;
  if (!isMap(jobs) || !isMap(jobs.viewport)) throw new Error('workflow has no "viewport" job');
  const job = jobs.viewport;
  if (!Array.isArray(job.steps) || !job.steps.every(isMap)) throw new Error("viewport job has no steps");
  return { raw, doc: parsed, job, steps: job.steps };
}

function runText(step: YMap): string {
  return typeof step.run === "string" ? step.run : "";
}

const UNTOUCHED_WORKFLOWS = [
  ".github/workflows/phone-checks.yml",
  ".github/workflows/deploy.yml",
  ".github/workflows/staging-e2e.yml",
];

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * "The app did not come up" is the health wait's FAILURE message: ci.yml prints it just before `exit 1`
 * (asserted by tests/ci-pr-2696.test.ts), viewport.yml does the same, and phone-checks.yml does too since
 * SHO-2559 gave its browser-tier job a real precondition. So the string being present in a workflow is not a
 * defect - what APL-2662 must keep out of the workflows it did not touch is the WORKAROUND: printing that note
 * and carrying on, so a run against a dead app looks like a green job. Each occurrence therefore has to be a
 * hard failure: the shell block it opens must reach `exit 1`, and the message line itself must not swallow its
 * own status (`|| true`, `|| :`, `exit 0`). Returns one line per occurrence that is a workaround instead.
 */
function nonFailingAppWaits(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const offenders: string[] = [];
  lines.forEach((line, index) => {
    if (!line.includes("The app did not come up")) return;
    const indent = line.search(/\S/);
    // The shell block this message belongs to: the following lines at its own indentation, stopping at the
    // first one indented less (the next step, `fi`, or a sibling key).
    const block: string[] = [line];
    for (let next = index + 1; next < lines.length; next++) {
      if (lines[next].trim() !== "" && lines[next].search(/\S/) < indent) break;
      block.push(lines[next]);
    }
    const why: string[] = [];
    if (!/\bexit 1\b/.test(block.join("\n"))) why.push("the block never exits 1");
    if (/\|\|\s*(true|:)\s*$/.test(line.trim()) || /\bexit 0\b/.test(line)) why.push("the message line swallows the failure");
    if (why.length > 0) offenders.push(`${line.trim()} -> ${why.join(", ")}`);
  });
  return offenders;
}

describe("CI runs the viewport tests in Playwright Chromium (APL-2662)", () => {
  it("Viewport tests run on every PR (qa:TC-APL2662-e1e4aac1@v1)", () => {
    const { doc, job, steps } = loadWorkflow();
    expect(path.basename(WORKFLOW_PATH)).toBe("viewport.yml");
    expect(WORKFLOW_PATH.includes(`${path.sep}.github${path.sep}workflows${path.sep}`)).toBe(true);

    const on = doc.on;
    expect(isMap(on), "workflow triggers on pull_request so GitHub reports the job on the PR").toBe(true);
    if (!isMap(on)) return;
    const pullRequest = on.pull_request;
    expect(isMap(pullRequest)).toBe(true);
    if (!isMap(pullRequest)) return;
    expect(pullRequest.branches).toEqual(["main"]);
    expect(pullRequest.paths).toBeUndefined();
    expect(pullRequest["paths-ignore"]).toBeUndefined();
    expect(pullRequest.types).toBeUndefined();

    expect(job.name).toBe("viewport");
    expect(job.if).toBeUndefined();

    const install = steps.find((step) => runText(step).includes("playwright-core install") && runText(step).includes("chromium"));
    const viewport = steps.find((step) => runText(step).trim() === "npm run test:viewport");
    expect(install, "viewport job installs Playwright Chromium").toBeDefined();
    expect(viewport, 'viewport job runs "npm run test:viewport"').toBeDefined();
    expect(steps.indexOf(install!)).toBeLessThan(steps.indexOf(viewport!));
    expect(steps.some((step) => runText(step).trim() === "npm ci")).toBe(true);
  });

  it("Viewport checks are a new workflow file (qa:TC-APL2662-6324c7e3@v1)", () => {
    const viewport = readFileSync(WORKFLOW_PATH, "utf8");
    expect(viewport).toContain("npm run test:viewport");
    expect(viewport).toContain("jobs:");
    for (const file of UNTOUCHED_WORKFLOWS) {
      const text = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(text, file).not.toContain("APL-2662");
      expect(text, file).not.toContain("playwright-browsers");
      expect(text, file).not.toContain("Playwright browsers restored from cache");
      // Not "the message is absent" - it is the health wait's real failure message and phone-checks.yml now
      // prints it for the browser tier (SHO-2559). What must stay out is the workaround: the message as a note
      // the job carries on past. Every occurrence has to fail the step (see nonFailingAppWaits).
      expect(nonFailingAppWaits(text), `${file} fails when the app does not come up`).toEqual([]);
    }
    const base = git(["rev-parse", "--verify", "origin/main"]);
    const onMain = git(["cat-file", "-e", "origin/main:.github/workflows/viewport.yml"]);
    if (base.status === 0 && onMain.status !== 0) {
      const diff = git(["diff", "--exit-code", "origin/main", "--", ...UNTOUCHED_WORKFLOWS]);
      expect(diff.status, `${diff.stdout}\n${diff.stderr}`).toBe(0);
    }
  });

  it("the narrowed app-start guard still rejects the workaround it exists for", () => {
    // Printable proof that narrowing the target kept it sharp: the workaround shape goes red...
    const workaround = [
      "      - name: Start the app",
      "        run: |",
      "          (npx next start -p 3100 > server.log 2>&1 &)",
      "          sleep 5",
      '          echo "The app did not come up: no answer" || true',
      "      - name: Viewport tests",
      "        run: npm run test:viewport",
    ].join("\n");
    const caught = nonFailingAppWaits(workaround);
    expect(caught).toHaveLength(1);
    expect(caught[0]).toContain("swallows the failure");
    // ...and the note printed without any failure at all is caught too...
    const silent = ["          echo 'The app did not come up' >&2", "      - run: npm run test:viewport"].join("\n");
    expect(nonFailingAppWaits(silent)).toHaveLength(1);
    // ...while the legitimate shape - the message, then a hard exit, as ci.yml, viewport.yml and
    // phone-checks.yml all have it - passes.
    const legitimate = [
      "          if [ \"$ready\" -ne 1 ]; then",
      '            echo "The app did not come up: ${url} did not answer within the timeout" >&2',
      "            tail -n 50 server.log >&2 || true",
      "            exit 1",
      "          fi",
    ].join("\n");
    expect(nonFailingAppWaits(legitimate)).toEqual([]);
  });

  it("A failing viewport test fails the job (qa:TC-APL2662-d83a7e4c@v1)", { timeout: 90_000 }, () => {
    const { job, steps } = loadWorkflow();
    const viewport = steps.find((step) => runText(step).trim() === "npm run test:viewport");
    expect(viewport, 'viewport job runs "npm run test:viewport"').toBeDefined();
    expect(viewport?.["continue-on-error"]).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    expect(runText(viewport!)).not.toMatch(/\|\|\s*true/);
    expect(runText(viewport!)).not.toMatch(/\/dev\/null/);

    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { scripts: { "test:viewport": string } };
    const script = pkg.scripts["test:viewport"];
    expect(script.startsWith("vitest ")).toBe(true);

    const failingFile = path.join(process.cwd(), "tests/viewport", `deliberate-fail-${process.pid}.test.ts`);
    writeFileSync(
      failingFile,
      `import { expect, it } from "vitest";\nit(${JSON.stringify(FAILING_NAME)}, () => { expect(true).toBe(false); });\n`,
    );
    try {
      const args = [...script.split(/\s+/).slice(1), path.relative(process.cwd(), failingFile)];
      const result = spawnSync(process.execPath, [path.join(process.cwd(), "node_modules/vitest/vitest.mjs"), ...args], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 80_000,
        env: { ...process.env, GITHUB_ACTIONS: "true" },
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(result.status, output).not.toBe(0);
      expect(output).toContain(FAILING_NAME);
      // Vitest's GitHub reporter puts the failing test name in the check annotation title.
      expect(output).toMatch(new RegExp(`::error [^\\n]*title=[^\\n]*${FAILING_NAME}`));
      expect(output).not.toContain("loading.test.ts");
    } finally {
      rmSync(failingFile, { force: true });
    }
  });

  it("Browser download is cached (qa:TC-APL2662-9a100093@v1)", () => {
    const { job, steps } = loadWorkflow();
    const cache = steps.find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/cache@"));
    expect(cache, "Playwright browsers are stored with actions/cache").toBeDefined();
    expect(cache?.id).toBe("playwright-browsers");
    expect(isMap(cache?.with)).toBe(true);
    if (!isMap(cache?.with)) return;
    const cachePath = String(cache.with.path);
    const cacheKey = String(cache.with.key);
    expect(cachePath).toContain("ms-playwright");
    expect(cacheKey).toContain("hashFiles('package-lock.json')");
    expect(cacheKey).not.toMatch(/github\.(sha|run_id|run_number|run_attempt)/);

    expect(isMap(job.env)).toBe(true);
    if (!isMap(job.env)) return;
    expect(job.env.PLAYWRIGHT_BROWSERS_PATH).toBe(cachePath);

    const install = steps.find((step) => runText(step).includes("playwright-core install") && runText(step).includes("chromium"));
    expect(install).toBeDefined();
    expect(steps.indexOf(cache!)).toBeLessThan(steps.indexOf(install!));
    const installScript = runText(install!);
    expect(installScript).toContain("steps.playwright-browsers.outputs.cache-hit");
    expect(installScript).toContain("Playwright browsers restored from cache");
    const [cacheHit, cacheMiss] = installScript.split("else");
    expect(cacheHit).toContain("npx playwright-core install-deps chromium");
    expect(cacheHit).not.toContain("install --with-deps");
    expect(cacheMiss).toContain("npx playwright-core install --with-deps chromium");
    expect(cacheMiss).not.toContain("install-deps");
  });

  it("No production or staging secret is used (qa:TC-APL2662-d3047d35@v1)", () => {
    const { raw, doc, job } = loadWorkflow();
    const expressions = raw.match(/\$\{\{[^}]+\}\}/g) ?? [];
    const allowed = new Set([
      "${{ github.ref }}",
      "${{ github.workspace }}",
      "${{ runner.os }}",
      "${{ hashFiles('package-lock.json') }}",
      "${{ steps.playwright-browsers.outputs.cache-hit }}",
    ]);
    for (const expression of expressions) expect(allowed.has(expression), expression).toBe(true);
    expect(raw.includes("secrets.")).toBe(false);
    expect(raw.includes("vars.")).toBe(false);

    const forbidden = /secrets\.|sheethappensofficer\.com|\bSTAGING_|\bSHO_ADMIN_|\bSHO_MEMBER_|\bZZ_TEST_|SSH_PRIVATE_KEY|RESEND_API_KEY|ANTHROPIC_API_KEY|CONCIERGE_EVAL_API_KEY|RESTORE_DATABASE_URL|DROPLET_HOST/i;
    for (const value of stringsIn(doc)) expect(value, value).not.toMatch(forbidden);
    expect(job.environment).toBeUndefined();
    expect(doc.environment).toBeUndefined();
  });

  it("The health check fails the job when the app never comes up", () => {
    const { steps } = loadWorkflow();
    const start = steps.find((step) => step.name === "Start the app");
    expect(start, "the viewport job waits for the app").toBeDefined();
    expect(start?.["continue-on-error"]).toBeUndefined();
    const script = runText(start!);
    expect(script).toContain("/api/health");
    expect(script).toContain('echo "The app did not come up: ${url} did not answer within the timeout"');
    expect(script.trimEnd().endsWith("exit 1")).toBe(true);
    expect(script).not.toMatch(/curl[^\n]*\|\|\s*true/);

    const bin = mkdtempSync(path.join(tmpdir(), "viewport-health-"));
    try {
      writeFileSync(path.join(bin, "npx"), "#!/bin/sh\nexit 0\n");
      chmodSync(path.join(bin, "npx"), 0o755);
      const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
        cwd: bin,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          APP_HEALTH_URL: "http://127.0.0.1:9/api/health",
          APP_HEALTH_ATTEMPTS: "2",
          APP_HEALTH_PAUSE: "0",
        },
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(result.status, output).not.toBe(0);
      expect(output).toContain("The app did not come up:");
      expect(output).toContain("did not answer within the timeout");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
