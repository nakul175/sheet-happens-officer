// SHO-2886. A `playwright test --list` guard must print the failure it saw *before* the step goes red, so a red
// step carries a diagnosis. These checks do not read the shell as text: each `--list` guard body is lifted out of
// .github/workflows/ci.yml and run under `bash -e` (the shell GitHub Actions gives a `run:` step) with a stand-in
// `npx` that fails the way the real CLI does. A real collection failure exits 1, writes `Total: 0 tests in 0 files`
// to stdout and the cause ("Error: Cannot find module …" plus its code frame) to stderr, so the stand-in does too.
//
// The assertion that fails without the guard capturing its output: the step's own stdout must carry the cause. An
// uncaptured child's stderr still reaches the CI log by accident, but then the guard's `::error::` annotation says
// "collected 0 tests" -- a count problem -- when the failure was a spec that could not load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

/** The `run: |` body of the step named `name`, up to the next step name, with the YAML's 10-space indent removed. */
function stepBody(name, nextName) {
  const step = WORKFLOW.split(`- name: ${name}`)[1]?.split(`- name: ${nextName}`)[0];
  assert.ok(step, `ci.yml has no step "${name}" followed by "${nextName}"`);
  const body = step.split("run: |")[1];
  assert.ok(body, `the step "${name}" has no \`run: |\` body`);
  const lines = body.split("\n");
  // The step's own comment back in the job, at the job's indent, ends the body.
  const end = lines.findIndex((line) => /^ {6}#/.test(line));
  return lines
    .slice(0, end === -1 ? lines.length : end)
    .map((line) => line.replace(/^ {10}/, ""))
    .filter((line) => line.trim() !== "")
    .join("\n");
}

/** What the real `npx playwright test --list` prints on a collection failure, and on a clean listing. */
const FAILURE = {
  status: 1,
  out: ["Listing tests:", "Total: 0 tests in 0 files"],
  err: ["", "Error: Cannot find module 'w331-stub-package'", "   at APL-9999.spec.ts:2"],
};
const CLEAN = { status: 0, out: ["Listing tests:", "  APL-2624.spec.ts:1:1 > AC1: x", "Total: 9 tests in 1 file"], err: [] };

/** Run one step body under `bash -e`, with `npx` replaced by the stream/status pair above. */
function runStep(body, npx) {
  const dir = mkdtempSync(join(tmpdir(), "ci-list-guard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const lines = ["#!/bin/sh"];
  for (const line of npx.out) lines.push(`printf '%s\\n' ${JSON.stringify(line)}`);
  for (const line of npx.err) lines.push(`printf '%s\\n' ${JSON.stringify(line)} >&2`);
  lines.push(`exit ${npx.status}`);
  writeFileSync(join(bin, "npx"), `${lines.join("\n")}\n`, { mode: 0o755 });
  const script = join(dir, "step.sh");
  writeFileSync(script, `${body}\n`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const res = spawnSync("bash", ["-e", script], { cwd: dir, env, encoding: "utf8" });
  assert.equal(res.status === null, false, `bash did not run the step: ${res.error?.message}`);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const STORY = stepBody("Playwright collects the story specs", "Lint");
const LOCAL = stepBody("Local Playwright story specs", "CRM visible modes");

/** The step failed, and the cause it captured came out before the red annotation. */
function assertDiagnosed(step, res, annotation) {
  assert.notEqual(res.status, 0, `the step passed on a failed --list\nstdout:\n${res.stdout}`);
  const cause = res.stdout.indexOf("Error: Cannot find module 'w331-stub-package'");
  const red = res.stdout.indexOf(annotation);
  assert.notEqual(cause, -1, `the step never printed the --list error it captured\nstdout:\n${res.stdout}`);
  assert.notEqual(red, -1, `the step never printed its ::error:: annotation\nstdout:\n${res.stdout}`);
  assert.ok(cause < red, `the ::error:: annotation came before the cause\nstdout:\n${res.stdout}`);
}

test("a failed --list makes the story-specs guard print its error, then fail", () => {
  const res = runStep(STORY, FAILURE);
  assertDiagnosed(STORY, res, "::error::Playwright collected 0 tests from tests/e2e/stories.");
});

test("a clean --list still passes the story-specs guard", () => {
  const res = runStep(STORY, CLEAN);
  assert.equal(res.status, 0, `the guard failed a clean listing\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /Playwright story tests collected: 9/);
});

test("a failed --list makes the local-specs guard print its error, then fail", () => {
  const res = runStep(LOCAL, FAILURE);
  assertDiagnosed(LOCAL, res, "::error::Playwright collected 0 tests from tests/e2e/stories/APL-2624.spec.ts.");
});

test("a clean --list still passes the local-specs guard", () => {
  const res = runStep(LOCAL, CLEAN);
  assert.equal(res.status, 0, `the guard failed a clean listing\nstdout:\n${res.stdout}`);
  for (const spec of ["APL-2624", "APL-2721", "APL-2737"]) {
    assert.match(res.stdout, new RegExp(`tests/e2e/stories/${spec}\\.spec\\.ts: 9 tests`));
  }
});

test("no --list guard pipes the CLI straight into sed, where its error cannot be printed", () => {
  for (const body of [STORY, LOCAL]) {
    assert.doesNotMatch(body, /npx playwright test --list [^|\n]*\| *sed/);
  }
});
