// APL-2662: CI runs the viewport tests in Playwright Chromium.
// One test per approved Gherkin scenario (Michael, v1).
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("CI runs the viewport tests in Playwright Chromium (APL-2662)", () => {
  it("Viewport tests run on every PR", () => {
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

  it("A failing viewport test fails the job", { timeout: 90_000 }, () => {
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

  it("Browser download is cached", () => {
    const { raw, doc, job, steps } = loadWorkflow();
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
    expect(runText(install!)).toContain("steps.playwright-browsers.outputs.cache-hit");
    expect(runText(install!)).toContain("Playwright browsers restored from cache");

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
});
