// Refs APL-2696. The pull-request workflow is the thing under test.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const wrapper = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const shared = readFileSync(new URL("../.github/workflows/qualification.yml", import.meta.url), "utf8");
// Expand the referenced job for the existing behavioral assertions; the wrapper is checked below.
const workflow = wrapper.slice(0, wrapper.indexOf("jobs:\n")) + shared.slice(shared.indexOf("jobs:\n"));
it("PR wrapper uses the exact shared qualification workflow", () => expect(wrapper).toContain("uses: ./.github/workflows/qualification.yml"));

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
    writeFileSync(path.join(bin, "node"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "node"), 0o755);
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
  expect(workflow).toContain("run: node scripts/ci/measure-command.mjs test-results/build-capacity.json -- npm run build");
});

it("AC2 a non-zero lint, tsc, unit test or build fails the job", () => {
  expect(workflow).not.toContain("continue-on-error");
  for (const command of ["npm run lint", "npx next typegen && npx tsc --noEmit", "npm test", "npm run build"]) {
    const line = workflow.split("\n").find((row) => row.includes(command));
    expect(line, command).toBeTruthy();
    expect(line).not.toContain("|| true");
  }
});

it("the measured build wrapper propagates a command failure", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-build-capacity-"));
  try {
    const receipt = path.join(dir, "receipt.json");
    const result = spawnSync(process.execPath, [
      "scripts/ci/measure-command.mjs", receipt, "--", process.execPath, "-e", "process.exit(7)",
    ], { encoding: "utf8" });
    expect(result.status).toBe(7);
    expect(JSON.parse(readFileSync(receipt, "utf8")).exitCode).toBe(7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the measured build wrapper records available memory and tolerates missing proc data", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-build-memory-"));
  try {
    const meminfo = path.join(dir, "meminfo");
    const receipt = path.join(dir, "receipt.json");
    writeFileSync(meminfo, "MemTotal: 8192000 kB\nMemAvailable: 4194304 kB\n");
    const command = ["scripts/ci/measure-command.mjs", receipt, "--", process.execPath, "-e", "process.exit(0)"];
    const measured = spawnSync(process.execPath, command, {
      encoding: "utf8", env: { ...process.env, BUILD_CAPACITY_MEMINFO_PATH: meminfo },
    });
    expect(measured.status).toBe(0);
    const first = JSON.parse(readFileSync(receipt, "utf8"));
    expect(first.memoryAvailableKiBBefore).toBe("4194304");
    expect(first.minimumMemoryAvailableKiB).toBe("4194304");
    expect(first.memoryAvailableKiBAfter).toBe("4194304");
    const lowering = spawnSync(process.execPath, ["scripts/ci/measure-command.mjs", receipt, "--", process.execPath,
      "-e", 'setTimeout(() => require("fs").writeFileSync(process.env.BUILD_CAPACITY_MEMINFO_PATH, "MemAvailable: 3000000 kB\\n"), 100); setTimeout(() => process.exit(0), 650)'], {
      encoding: "utf8", env: { ...process.env, BUILD_CAPACITY_MEMINFO_PATH: meminfo },
    });
    expect(lowering.status).toBe(0);
    const low = JSON.parse(readFileSync(receipt, "utf8"));
    expect(low.memoryAvailableKiBBefore).toBe("4194304");
    expect(low.minimumMemoryAvailableKiB).toBe("3000000");
    expect(low.memoryAvailableKiBAfter).toBe("3000000");
    const missing = spawnSync(process.execPath, command, {
      encoding: "utf8", env: { ...process.env, BUILD_CAPACITY_MEMINFO_PATH: path.join(dir, "missing") },
    });
    expect(missing.status).toBe(0);
    const second = JSON.parse(readFileSync(receipt, "utf8"));
    expect(second.memoryAvailableKiBBefore).toBeNull();
    expect(second.minimumMemoryAvailableKiB).toBeNull();
    expect(second.memoryAvailableKiBAfter).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
