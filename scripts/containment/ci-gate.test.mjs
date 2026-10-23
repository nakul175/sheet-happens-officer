// CONTAINMENT / CI — the gate that keeps the Rev-3 containment scripts from regressing between the review
// that approved them and the day the human runs them.
//
// scripts/containment/*.sh is the only thing between "slot 9 is contained" and an unfounded claim, and its
// 38 tests run offline - so they CAN run in CI, and until now nothing did. A red-team commit (208a279) that
// inverted the proof verdict had to be caught by hand.
//
// This file grades .github/workflows/containment.yml the same way the rest of the packet grades the scripts:
// structurally (a small YAML-subset parse, no dependency added) and behaviourally (the syntax-check and
// shellcheck steps are EXTRACTED from the YAML and actually run, so a step that is present but vacuous - a
// `find` that matches nothing, a `command -v` guard that always skips - fails here rather than in CI).
//
// Nothing here touches a host, needs root, reads an env file, or writes outside a temp dir.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOW_REL = ".github/workflows/containment.yml";
const WORKFLOW = join(ROOT, WORKFLOW_REL);
const CI = join(ROOT, ".github/workflows/ci.yml");

const read = (path) => readFileSync(path, "utf8");

// ---------------------------------------------------------------------------------------------------------
// A deliberately small YAML subset: block mappings, block sequences, literal block scalars (| and >) and
// plain/quoted scalars. It is enough for these workflow files and it THROWS on a line it cannot classify,
// so a construct it does not understand can never be mistaken for a passing parse. Flow collections
// ([...] / {...}) are refused on purpose: the gate's assertions are structural, and a hidden inline
// structure would defeat them. No dependency was added to parse YAML (see W94-REPORT.md).
// ---------------------------------------------------------------------------------------------------------

const indentOf = (line) => line.length - line.trimStart().length;

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    // `#` opens a comment only at the start of the line or after whitespace.
    if (char === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

const MAPPING_LINE = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/;

function splitKey(text) {
  const match = MAPPING_LINE.exec(text);
  return match ? { key: match[1], rest: (match[2] ?? "").trim() } : null;
}

function scalar(text) {
  const trimmed = text.trim();
  const quoted = /^"(.*)"$/.exec(trimmed) ?? /^'(.*)'$/.exec(trimmed);
  const value = quoted ? quoted[1] : trimmed;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[[{]/.test(value)) throw new Error(`flow collections are not supported here: ${trimmed}`);
  return value;
}

function parseYaml(text) {
  // Keep the raw line for block scalars, and a comment-stripped copy for everything else.
  const lines = text.split(/\r?\n/).map((raw) => {
    const stripped = stripComment(raw).replace(/\s+$/, "");
    // `text` is the trimmed line: every comparison below is about content, and `indent` carries the depth.
    return { raw, text: stripped.trimStart(), indent: indentOf(stripped) };
  });

  const skipBlank = (from) => {
    let i = from;
    while (i < lines.length && lines[i].text.trim() === "") i += 1;
    return i;
  };

  function blockScalar(from, parentIndent) {
    const collected = [];
    let i = from;
    let childIndent = null;
    while (i < lines.length) {
      const line = lines[i];
      const blank = line.raw.trim() === "";
      if (!blank && indentOf(line.raw) <= parentIndent) break;
      if (!blank && childIndent === null) childIndent = indentOf(line.raw);
      collected.push(line.raw);
      i += 1;
    }
    const dedent = childIndent ?? 0;
    return [
      collected.map((line) => (line.trim() === "" ? "" : line.slice(dedent))).join("\n").replace(/\n+$/, ""),
      i,
    ];
  }

  function mapping(from) {
    const start = skipBlank(from);
    assert.ok(start < lines.length, "a mapping block is never empty");
    const indent = lines[start].indent;
    const out = {};
    let i = start;
    for (;;) {
      i = skipBlank(i);
      if (i >= lines.length) break;
      const line = lines[i];
      if (line.indent !== indent || line.text.startsWith("- ")) break;
      const split = splitKey(line.text);
      assert.ok(split, `line ${i + 1} is not a mapping entry this parser understands: ${JSON.stringify(line.raw)}`);
      const { key, rest } = split;
      if (rest === "") {
        const next = skipBlank(i + 1);
        const nested =
          next < lines.length &&
          (lines[next].indent > indent ||
            (lines[next].indent === indent && (lines[next].text === "-" || lines[next].text.startsWith("- "))));
        if (nested) {
          const [child, after] = node(next);
          out[key] = child;
          i = after;
        } else {
          out[key] = null;
          i += 1;
        }
        continue;
      }
      if (/^[|>][+-]?$/.test(rest)) {
        const [body, after] = blockScalar(i + 1, indent);
        out[key] = body;
        i = after;
        continue;
      }
      out[key] = scalar(rest);
      i += 1;
    }
    return [out, i];
  }

  function sequence(from) {
    const start = skipBlank(from);
    const indent = lines[start].indent;
    const out = [];
    let i = start;
    for (;;) {
      i = skipBlank(i);
      if (i >= lines.length) break;
      const line = lines[i];
      if (line.indent !== indent) break;
      if (!(line.text === "-" || line.text.startsWith("- "))) break;
      const rest = line.text === "-" ? "" : line.text.slice(2).trim();
      if (rest === "") {
        const [child, after] = node(i + 1);
        out.push(child);
        i = after;
        continue;
      }
      // `- key: value` opens a mapping item whose keys sit two columns right of the dash.
      if (splitKey(rest)) {
        lines[i] = { raw: rest, text: rest, indent: indent + 2 };
        const [child, after] = mapping(i);
        out.push(child);
        i = after;
        continue;
      }
      out.push(scalar(rest));
      i += 1;
    }
    return [out, i];
  }

  function node(from) {
    const start = skipBlank(from);
    assert.ok(start < lines.length, "a nested block is never empty");
    const line = lines[start];
    if (line.text === "-" || line.text.startsWith("- ")) return sequence(start);
    return mapping(start);
  }

  const [doc] = node(0);
  return doc;
}

let cached = null;
function workflow() {
  if (!cached) cached = parseYaml(`${read(WORKFLOW)}\n`);
  return cached;
}

const steps = () => workflow().jobs.gate.steps;
const stepIndex = (predicate) => steps().findIndex(predicate);
const runOf = (predicate, what) => {
  const index = stepIndex(predicate);
  assert.notEqual(index, -1, `no step matches ${what}`);
  return String(steps()[index].run);
};

// Run an extracted step body exactly as GitHub runs it on ubuntu-latest:
// `bash --noprofile --norc -e -o pipefail <script>`.
function runStep(body, { cwd = ROOT, path = process.env.PATH, extraEnv = {} } = {}) {
  // Absolute bash: one call below deliberately hands the step an almost empty PATH.
  const res = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", body], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: path, ...extraEnv },
  });
  assert.equal(res.error, undefined, `could not run the step body: ${res.error}`);
  return res;
}

// Every *.sh under scripts/containment, recursively - the set the gate must cover, found independently
// of the workflow's own `find`.
function shellFiles(dir = join(ROOT, "scripts", "containment")) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...shellFiles(full));
    else if (entry.endsWith(".sh")) out.push(relative(ROOT, full));
  }
  return out.sort();
}

function testFiles() {
  return readdirSync(join(ROOT, "scripts", "containment"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort();
}

// ---------------------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------------------

test("the gate exists and parses as one job on the same Node major as ci.yml", () => {
  const doc = workflow();
  assert.equal(doc.name, "Containment gate");

  const jobs = Object.entries(doc.jobs ?? {});
  assert.equal(jobs.length, 1, "the packet asks for a single job");
  const [jobId, job] = jobs[0];
  assert.equal(jobId, "gate");
  // A hosted runner, not a self-hosted one: this gate must never depend on a real host.
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 15, "a hung gate must not hold a runner forever");

  const ciNode = /node-version:\s*["']?([^"'\s]+)/.exec(read(CI))?.[1];
  assert.ok(ciNode, "ci.yml must declare a node-version for this comparison to be meaningful");
  const setupNode = job.steps.find((step) => String(step.uses ?? "").startsWith("actions/setup-node@"));
  assert.ok(setupNode, "no actions/setup-node step");
  assert.equal(setupNode.with["node-version"], Number(ciNode), `setup-node must match ci.yml's ${ciNode}`);
  assert.equal(setupNode.with.cache, "npm", "npm ci without a cached npm store re-downloads every run");

  assert.ok(
    job.steps.some((step) => String(step.uses ?? "").startsWith("actions/checkout@")),
    "no checkout step",
  );
  assert.ok(
    job.steps.some((step) => /(^|\n)\s*npm ci\s*($|\n)/.test(String(step.run ?? ""))),
    "no `npm ci` step (the install step ci.yml uses)",
  );

  // First-party, major-pinned actions only: no third party in the supply chain of the gate itself.
  for (const step of job.steps) {
    if (step.uses === undefined) continue;
    assert.match(String(step.uses), /^actions\/[a-z-]+@v\d+$/, `unexpected action: ${step.uses}`);
  }
});

test("the test step runs every containment test file, including ones added later", () => {
  const body = runOf((step) => String(step.run ?? "").includes("node --test"), "the node --test step");
  const commands = body.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  assert.deepEqual(commands.length, 1, `expected one command, got ${JSON.stringify(commands)}`);

  const glob = /node --test\s+"?([^"\s]+)"?/.exec(body)?.[1];
  assert.ok(glob, "the step must pass a test path to node --test");
  assert.match(glob, /^scripts\/containment\//, "the test path must point at scripts/containment");

  // Expand the workflow's own pattern and prove it covers the directory. A new *.test.mjs cannot be
  // forgotten; dropping one from the command (or listing files one by one) fails here.
  const pattern = new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  const onDisk = testFiles();
  assert.ok(onDisk.length >= 3, `expected the containment suite on disk, found ${onDisk.length} files`);
  for (const name of onDisk) {
    assert.match(`scripts/containment/${name}`, pattern, `${glob} does not pick up ${name}`);
  }
  for (const required of [
    "containment-scripts.test.mjs",
    "w59-privilege-scope.test.mjs",
    "unit-env-sources.test.mjs",
  ]) {
    assert.ok(onDisk.includes(required), `${required} is missing from scripts/containment`);
    assert.match(`scripts/containment/${required}`, pattern);
  }
  // The step must not filter: a name pattern or --test-only would silently shrink the suite.
  assert.doesNotMatch(body, /--test-name-pattern|--test-only|--skip/);
});

test("the syntax check runs before the tests, and really covers lib/", () => {
  const syntaxIndex = stepIndex((step) => /bash -n/.test(String(step.run ?? "")));
  const testIndex = stepIndex((step) => String(step.run ?? "").includes("node --test"));
  assert.notEqual(syntaxIndex, -1, "no `bash -n` step: a syntax break must fail fast");
  assert.ok(syntaxIndex < testIndex, "`bash -n` must run before the slow test step");

  const body = runOf((step) => /bash -n/.test(String(step.run ?? "")), "the bash -n step");

  // Behaviour 1: against this tree it parses every script, and the set it reports is the whole tree.
  const real = runStep(body);
  assert.equal(real.status, 0, `the syntax step failed on a clean tree:\n${real.stdout}\n${real.stderr}`);
  const reported = real.stdout
    .split("\n")
    .filter((line) => line.startsWith("bash -n ok: "))
    .map((line) => line.slice("bash -n ok: ".length))
    .sort();
  assert.deepEqual(reported, shellFiles(), "the step must check every .sh under scripts/containment, lib/ included");
  assert.ok(reported.some((file) => file.includes("lib/")), "lib/*.sh were not covered");
  assert.match(real.stdout, new RegExp(`bash -n: ${shellFiles().length} file\\(s\\) parse`));

  // Behaviour 2: it is not vacuous. A tree with a syntax error fails, and an empty tree is refused.
  const sandbox = mkdtempSync(join(tmpdir(), "w94-bash-n-"));
  mkdirSync(join(sandbox, "scripts", "containment", "lib"), { recursive: true });
  writeFileSync(
    join(sandbox, "scripts", "containment", "lib", "ok.sh"),
    "#!/usr/bin/env bash\nset -euo pipefail\necho ok\n",
  );
  const clean = runStep(body, { cwd: sandbox });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /bash -n ok: scripts\/containment\/lib\/ok\.sh/, "the sandbox script was not checked");

  writeFileSync(join(sandbox, "scripts", "containment", "lib", "broken.sh"), "if [ ; then\n");
  const broken = runStep(body, { cwd: sandbox });
  assert.notEqual(broken.status, 0, "a script that does not parse must fail the step");
  assert.match(`${broken.stdout}${broken.stderr}`, /broken\.sh/);

  const empty = mkdtempSync(join(tmpdir(), "w94-bash-n-empty-"));
  mkdirSync(join(empty, "scripts", "containment"), { recursive: true });
  const nothing = runStep(body, { cwd: empty });
  assert.notEqual(nothing.status, 0, "a checkout with no scripts must fail, not pass vacuously");
});

test("shellcheck is skipped loudly when absent and gated when present", () => {
  const body = runOf((step) => /shellcheck/.test(String(step.run ?? "")), "the shellcheck step");

  // Absent: an empty PATH guarantees `command -v shellcheck` misses, on any runner image.
  const emptyBin = mkdtempSync(join(tmpdir(), "w94-noshellcheck-"));
  const absent = runStep(body, { path: emptyBin });
  assert.equal(absent.status, 0, `absent shellcheck must not fail the job:\n${absent.stdout}\n${absent.stderr}`);
  assert.match(absent.stdout, /shellcheck: not installed/, "the log must say which of the two happened");

  // Present, clean: the same step takes the other branch and reports the version it used.
  const bin = mkdtempSync(join(tmpdir(), "w94-shellcheck-"));
  const stub = join(bin, "shellcheck");
  writeFileSync(
    stub,
    '#!/usr/bin/env bash\ncase " $* " in *" --version "*) echo "version: 0.10.0"; exit 0;; esac\nexit "${STUB_EXIT_CODE:-0}"\n',
  );
  chmodSync(stub, 0o755);
  const present = runStep(body, { path: `${bin}:${process.env.PATH}`, extraEnv: { STUB_EXIT_CODE: "0" } });
  assert.equal(
    present.status,
    0,
    `present shellcheck must take the analysing branch:\n${present.stdout}\n${present.stderr}`,
  );
  assert.match(present.stdout, /shellcheck: present - 0\.10\.0/);
  assert.match(present.stdout, /free of severity=error findings/, "the step must finish the file list, not skip it");

  // Present, findings: the job fails. `|| true` on the warning pass must not swallow an error-level result.
  const findings = runStep(body, { path: `${bin}:${process.env.PATH}`, extraEnv: { STUB_EXIT_CODE: "1" } });
  assert.notEqual(findings.status, 0, "shellcheck findings must fail the job when shellcheck is available");
});

test("no secret, no privileged command, no remote shell", () => {
  const text = read(WORKFLOW);
  assert.doesNotMatch(text, /secrets\s*\./i, "a fork pull request has no secret to resolve");
  assert.doesNotMatch(text, /github\s*\.\s*token/i, "the default token is enough, and contents: read is all it needs");
  assert.doesNotMatch(text, /\bsudo\b/i, "the gate may not escalate");
  assert.doesNotMatch(text, /\bssh\b/i, "the gate may not reach a host");
  assert.doesNotMatch(text, /\bscp\b|\brsync\b|\bssh-keygen\b/i);
  assert.doesNotMatch(text, /^\s*-\s*run:\s*.*\bcurl\b/im, "no network fetch in the step bodies");

  assert.deepEqual(workflow().permissions, { contents: "read" }, "permissions must be exactly contents: read");
  // Read-only even when a step is added later: any write scope at owner level would break a fork PR.
  assert.doesNotMatch(text, /^\s*[a-z-]+:\s*write\s*$/m);
});

test("the triggers are push and pull_request, with paths limited to the scripts and the pipelines", () => {
  const on = workflow().on;
  assert.ok(on, "no `on:` block");
  assert.deepEqual(Object.keys(on).sort(), ["pull_request", "push"], "only push and pull_request may trigger it");

  const allowed = [/^scripts\/containment\//, /^\.github\/workflows\//, /^package\.json$/, /^package-lock\.json$/];
  for (const trigger of ["push", "pull_request"]) {
    const paths = on[trigger].paths;
    assert.ok(Array.isArray(paths) && paths.length > 0, `${trigger}.paths must be a non-empty list`);
    for (const entry of paths) {
      assert.ok(
        allowed.some((pattern) => pattern.test(entry)),
        `${trigger}.paths entry ${entry} is outside the scripts/workflows/package files`,
      );
    }
  }
});

