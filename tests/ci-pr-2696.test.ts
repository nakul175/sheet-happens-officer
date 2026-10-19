// Refs APL-2696. The pull-request workflow is the thing under test.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function between(start: string, end: string) {
  const from = workflow.indexOf(start);
  expect(from, start).toBeGreaterThan(-1);
  const to = workflow.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return workflow.slice(from, to);
}

function startScript() {
  const block = between("      - name: Start the app\n", "      - name: Unit tests\n");
  return block
    .split("\n")
    .slice(2)
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

function runStart(curlOk: boolean) {
  const bin = mkdtempSync(path.join(tmpdir(), "ci-health-"));
  try {
    writeFileSync(path.join(bin, "npx"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "npx"), 0o755);
    if (curlOk) {
      writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 0\n");
      chmodSync(path.join(bin, "curl"), 0o755);
    }
    return spawnSync("bash", ["-eo", "pipefail", "-c", startScript()], {
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
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

it("AC1 every pull request runs lint, tsc, unit tests and build", () => {
  expect(between("on:\n", "\npermissions:")).toContain("pull_request:");
  expect(workflow).toContain("run: npm run lint");
  expect(workflow).toContain("npx next typegen && npx tsc --noEmit");
  expect(workflow).toContain("run: npm test");
  expect(workflow).toContain("run: npm run build");
});

it("AC2 a non-zero lint, tsc, unit test or build fails the job", () => {
  expect(workflow).not.toContain("continue-on-error");
  for (const command of ["npm run lint", "npx next typegen && npx tsc --noEmit", "npm test", "npm run build"]) {
    const line = workflow.split("\n").find((row) => row.includes(command));
    expect(line, command).toBeTruthy();
    expect(line).not.toContain("|| true");
  }
});

it("AC3 the health check fails the job when the app never answers", () => {
  const script = startScript();
  const failAt = script.indexOf("echo 'The app did not come up' >&2");
  const exitAt = script.indexOf("\n  exit 1\n", failAt);
  expect(failAt).toBeGreaterThan(-1);
  expect(exitAt).toBeGreaterThan(failAt);
  expect(script.slice(exitAt).trimEnd().endsWith("fi")).toBe(true);
  const failed = runStart(false);
  const output = `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`;
  expect(failed.status, output).not.toBe(0);
  expect(output).toContain("The app did not come up");
  const ready = runStart(true);
  expect(ready.status, `${ready.stdout ?? ""}\n${ready.stderr ?? ""}`).toBe(0);
});

it("AC4 the workflow triggers on pull_request only", () => {
  const on = between("on:\n", "\npermissions:");
  expect(on).toContain("pull_request:");
  expect(on).not.toContain("push:");
  expect(on).not.toContain("pull_request_target:");
  expect(on).not.toContain("workflow_dispatch:");
});

it("AC5 permissions are contents read only", () => {
  const permissions = between("permissions:\n", "\nconcurrency:");
  expect(permissions).toBe("permissions:\n  contents: read\n");
  expect(workflow).not.toMatch(/permissions:[\s\S]*write/);
});

it("AC6 the workflow references no repository secrets", () => {
  expect(workflow).not.toContain("secrets.");
  expect(workflow).toContain("postgresql://sho:sho@localhost:5432/sho_test");
  expect(workflow).toContain("JOB_SECRET: ci-only-not-a-real-secret-0123");
});

it("AC7 concurrency cancels the older run", () => {
  const concurrency = between("concurrency:\n", "\njobs:");
  expect(concurrency).toContain("cancel-in-progress: true");
  expect(concurrency).toContain("github.ref");
});
