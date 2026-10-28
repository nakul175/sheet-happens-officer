// SHO-2873. `.github/workflows/ci.yml` invoked `npm run test:crm-modes` in two steps: the APL-2713 step
// right after "Install Playwright Chromium" and the APL-2728 step beside the reminder/stalled mode tiers.
// Both steps carried the same command, the same job-level env and no `if:`, `env:` or `continue-on-error:`
// of their own, so the tier ran twice and the job's wall time carried it twice. Nothing asserted "once",
// which is why the second copy could be added without a red run.
//
// A per-mode tier starts one `next start` per CRM_VISIBLE mode and tears it down; running the same script,
// with the same config and the same env, a second time in the same job exercises nothing new. These checks
// fail when a tier is invoked more than once, and when the surviving invocation sits before what it needs:
// the production build and Playwright Chromium (vitest.crm-visible-modes.config.mts includes
// tests/e2e/local/APL-2609.spec.ts, a Playwright spec, and the tier's servers are `next start`).
//
// Run by ci.yml's "Node tests for scripts/ci" step, before `npm ci`: node builtins only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

/** Every script in ci.yml that starts one production server per CRM_VISIBLE mode. */
const MODE_TIERS = ["npm run test:crm-modes", "npm run test:reminder-modes", "npm run test:stalled-modes"];

/** A line with its YAML comment removed. A `#` starts a comment only at line start or after whitespace,
 *  so a name mentioned inside a comment cannot satisfy a count (that is how a duplicate hides). */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).replace(/\s+$/, "");
  }
  return line.replace(/\s+$/, "");
}

/** The `steps:` entries of the ci.yml job: [{ name, run }], comments removed, block scalars folded in. */
function steps(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^ {4}steps:\s*$/.test(stripComment(line)));
  assert.notEqual(start, -1, "ci.yml has no `steps:` list under the job");

  const bodies = [];
  let current = null;
  for (const raw of lines.slice(start + 1)) {
    const line = stripComment(raw);
    if (line.trim() === "") continue;
    const indent = line.match(/^ */)[0].length;
    if (indent <= 4) break; // back out to the job's other keys
    if (indent === 6 && line.slice(6).startsWith("- ")) {
      current = [line.slice(6).replace(/^-\s*/, "")];
      bodies.push(current);
    } else if (current) {
      current.push(line.trim());
    }
  }
  return bodies.map((body) => ({ name: nameOf(body), run: runOf(body) }));
}

function nameOf(body) {
  for (const line of body) {
    const match = /^name:\s*(.+)$/.exec(line);
    if (match) return match[1].trim();
  }
  return "";
}

/** A step's command: the inline `run:` value, or the body of a `run: |` / `run: >-` block. */
function runOf(body) {
  const at = body.findIndex((line) => /^run:\s*/.test(line));
  if (at === -1) return "";
  const head = body[at].replace(/^run:\s*/, "").trim();
  if (!/^[|>][-+]?$/.test(head)) return head;
  // A block scalar: the rest of the step. Everything after the header belongs to the command.
  return body.slice(at + 1).join("\n");
}

/** The steps whose `run:` invokes that tier script, as a command (an argument list still counts once). */
function tierSteps(source, script) {
  const pattern = new RegExp(`^\\s*${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "m");
  return steps(source).filter((step) => pattern.test(step.run));
}

test("SHO-2873: ci.yml invokes each per-mode tier in exactly one step", () => {
  for (const script of MODE_TIERS) {
    const found = tierSteps(CI, script);
    assert.equal(
      found.length,
      1,
      `${script} runs in ${found.length} steps (${found.map((s) => `"${s.name}"`).join(", ") || "none"}); ` +
        "a second identical step doubles that tier's wall time and covers nothing",
    );
  }
});

test("SHO-2873: the CRM mode tier sits after the build and after Playwright Chromium", () => {
  const all = steps(CI);
  const build = all.findIndex((step) => step.name === "Build");
  const chromium = all.findIndex((step) => step.name === "Install Playwright Chromium");
  const tier = all.findIndex((step) => step.run.startsWith("npm run test:crm-modes"));
  assert.notEqual(build, -1, "ci.yml lost its Build step");
  assert.notEqual(chromium, -1, "ci.yml lost its Playwright Chromium install");
  assert.notEqual(tier, -1, "ci.yml no longer runs npm run test:crm-modes");
  assert.ok(tier > build, "the tier starts `next start` servers and needs the build first");
  assert.ok(tier > chromium, "the tier runs tests/e2e/local/APL-2609.spec.ts, which needs Chromium");
});

test("SHO-2873: the duplicate check counts steps and commands, not mentions", () => {
  const step = (name, run) => `      - name: ${name}\n        run: ${run}\n`;
  const twoCopies = `jobs:\n  test:\n    steps:\n${step("A", "npm run test:crm-modes")}${step("B", "npm run test:crm-modes")}`;
  assert.equal(tierSteps(twoCopies, "npm run test:crm-modes").length, 2, "a second step is counted");

  const inComment = `jobs:\n  test:\n    steps:\n      # APL-2713: npm run test:crm-modes used to run here\n${step("A", "npm run test:crm-modes")}`;
  assert.equal(tierSteps(inComment, "npm run test:crm-modes").length, 1, "a comment is not an invocation");

  const inBody = `jobs:\n  test:\n    steps:\n      - name: All\n        run: |\n          npm run build\n          npm run test:crm-modes\n`;
  assert.equal(tierSteps(inBody, "npm run test:crm-modes").length, 1, "a block-scalar body is read");
});
