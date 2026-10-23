// CI tier — THE ROUTER ROOT, THE ONE THING NOTHING OFFLINE WAS CHECKING.
//
// Measured at the candidate head before this file existed: every route answered 404 while the containment suite
// stayed 86/86 green. The cause was a directory, not code. A commit added
// app/sho-status-plan/execution/PHASE2-CONTRACT.md — Markdown, nothing routable — and Next 16 then resolved the App
// Router to ./app instead of ./src/app. GET /api/health = 404, GET / = 404; remove the directory and both are 200.
// Commit 7dd3581 ("keep the phase-2 contract out of the router root") moved the file to scripts/containment/.
//
// No test in that suite could have caught it, because nothing in it ever starts the app, and the failure is a
// decision Next makes from the SHAPE of the tree before any route runs. So this file checks the shape, and only the
// shape: it reads the filesystem. No server, no DB, no browser, no network, no child process.
//
// The rule it enforces has two halves:
//   1. src/app exists and is the router root next to next.config.ts.
//   2. No repo-root app/ exists at all — directory or file, empty or full, .md or .tsx. The .md is what did it.
// If a future commit genuinely needs a root app/, it cannot slip past: the failure names this incident, and the
// only way through is to change this file too. That change is the record of the decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CI_WORKFLOW = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

/** The message a shadowed router root produces. It names the incident on purpose: a gate that only says "app/
 *  exists" invites the next author to delete the check instead of reading why it is there. */
export const INCIDENT = [
  "a repo-root app/ shadows src/app: Next 16 resolves the App Router to ./app and every route 404s.",
  "This is exactly what commit 7dd3581 had to undo: app/sho-status-plan/execution/PHASE2-CONTRACT.md was committed",
  "(a Markdown file, no code) and GET /api/health and GET / both answered 404 while the offline suite stayed green.",
  "Content does not matter - any file or directory named app/ at the repo root is enough.",
  "If a root app/ is genuinely needed, move the file or change this test as a deliberate act; do not route around it.",
].join("\n");

/** Everything under dir, relative and sorted; capped so a huge tree cannot flood a failure message. */
function entriesOf(dir, cap = 50) {
  const out = [];
  const walk = (current, prefix) => {
    if (out.length >= cap) return;
    const dirents = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      out.push(rel);
      if (out.length >= cap) return;
      if (dirent.isDirectory()) walk(join(current, dirent.name), rel);
    }
  };
  walk(dir, "");
  return out;
}

/** True for a file or a directory (or any other entry) that stat(2) can see. */
function present(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every way `root` is not a bootable Next project root. Empty means the shape is the one the repo has: src/app is the
 * router root and nothing at `root` shadows it. Takes a root so the tests below can attack it with throwaway trees.
 */
export function routerRootProblems(root) {
  const problems = [];

  if (!present(join(root, "next.config.ts"))) {
    problems.push(
      `next.config.ts is not at ${root}: without it there is no project root for src/app to sit next to, ` +
        "so this check cannot say what Next will treat as the router.",
    );
  }

  if (!isDirectory(join(root, "src/app"))) {
    problems.push(
      `src/app is missing (or is not a directory) at ${root}: the router lives there, next to next.config.ts, ` +
        "and a candidate without it serves 404 for every route including /api/health.",
    );
  }

  if (present(join(root, "app"))) {
    const shadow = join(root, "app");
    let shape;
    if (isDirectory(shadow)) {
      const entries = entriesOf(shadow);
      shape = entries.length === 0 ? "an empty directory" : `a directory holding ${entries.slice(0, 5).join(", ")}`;
    } else {
      shape = "a file";
    }
    problems.push(`${INCIDENT}\nFound ${shape} at app/ under ${root}.`);
  }

  return problems;
}

function fixture({ nextConfig = true, srcApp = true, dirs = [], files = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sho-router-root-"));
  if (nextConfig) writeFileSync(join(root, "next.config.ts"), "export default {};\n");
  for (const dir of [...(srcApp ? ["src/app"] : []), ...dirs]) mkdirSync(join(root, dir), { recursive: true });
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return root;
}

test("the repository's router root is src/app and nothing at the repo root shadows it", () => {
  const problems = routerRootProblems(ROOT);
  assert.deepEqual(problems, [], `the candidate cannot boot its own routes:\n\n${problems.join("\n\n")}`);
});

test("a stray Markdown file under a repo-root app/ is refused - the exact shape of the incident", (t) => {
  // The file that did it. It is not imported by anything and contains no code; presence alone was enough.
  const root = fixture({ files: ["app/sho-status-plan/execution/PHASE2-CONTRACT.md"] });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const problems = routerRootProblems(root);
  assert.equal(problems.length, 1, `expected exactly one problem, got:\n${problems.join("\n\n")}`);
  assert.match(problems[0], /sho-status-plan\/execution\/PHASE2-CONTRACT\.md/, "the failure must name the shadowing file");
  assert.match(problems[0], /\/api\/health/, "the failure must say which route it noticed");
  assert.match(problems[0], /404/, "the failure must state the symptom");
  assert.match(problems[0], /7dd3581/, "the failure must point at the commit that undid this once already");
});

test("the content of a repo-root app/ never matters: empty, one file, or a whole tree are all refused", (t) => {
  const shapes = [
    { label: "an empty directory", dirs: ["app"] },
    { label: "one .tsx file", files: ["app/page.tsx"] },
    { label: "one .md file", files: ["app/notes.md"] },
    { label: "a nested tree", files: ["app/a/b/c/plan.md", "app/a/b/d/notes.txt"] },
    { label: "a plain file named app", files: ["app"] },
  ];
  for (const shape of shapes) {
    const root = fixture({ dirs: shape.dirs, files: shape.files });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const problems = routerRootProblems(root);
    assert.equal(problems.length, 1, `${shape.label} at app/ was accepted:\n${problems.join("\n\n")}`);
    assert.match(problems[0], /shadows src\/app/, `${shape.label} did not produce the incident message`);
  }
});

test("a missing src/app is refused, and says which directory the router should be in", (t) => {
  const root = fixture({ srcApp: false });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const problems = routerRootProblems(root);
  assert.equal(problems.length, 1, `expected exactly one problem, got:\n${problems.join("\n\n")}`);
  assert.match(problems[0], /src\/app is missing/);
  assert.match(problems[0], /next\.config\.ts/);
});

test("a missing next.config.ts is refused: without it there is no project root to describe", (t) => {
  const root = fixture({ nextConfig: false });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const problems = routerRootProblems(root);
  assert.equal(problems.length, 1, `expected exactly one problem, got:\n${problems.join("\n\n")}`);
  assert.match(problems[0], /next\.config\.ts is not at/);
});

test("missing src/app and a shadowing app/ are both reported, not just the first one found", (t) => {
  const root = fixture({ srcApp: false, files: ["app/PHASE2-CONTRACT.md"] });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const problems = routerRootProblems(root);
  assert.equal(problems.length, 2, `one problem hid the other:\n${problems.join("\n\n")}`);
  assert.ok(problems.some((problem) => /src\/app is missing/.test(problem)));
  assert.ok(problems.some((problem) => /shadows src\/app/.test(problem)));
});

test("this gate is collected by the CI tier, so it cannot pass by never running", () => {
  // The workflow runs the whole directory. A file here is collected; a file somewhere else is not.
  assert.match(CI_WORKFLOW, /node --test "scripts\/ci\/\*\*\/\*\.test\.mjs"/, "ci.yml no longer runs scripts/ci/**/*.test.mjs");
});
