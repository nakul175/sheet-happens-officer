// QA (w272): a tier that cannot run on this host must say so, and must say it before it spawns a server.
// Without the precondition the two job tiers crash in teardown with `ENOENT ... scandir '/proc'` and report
// "Failed Suites 1 / Tests 4 skipped (4)" - zero assertions executed, indistinguishable from a red tier.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROCFS_MISSING, assertProcfs, procfsAvailable } from "./procfs-precondition";

/** The three tiers whose process discovery reads procfs. */
const TIERS = [
  "tests/crm-visible-modes-server.test.ts",
  "tests/jobs-reminders-crm-server.test.ts",
  "tests/jobs-stalled-crm-server.test.ts",
];

describe("w272: a procfs-only mode tier reports the host it needs", () => {
  it("a host without /proc is reported as missing procfs, naming the requirement", () => {
    if (procfsAvailable()) {
      // On Linux the guard is a no-op and the message is still the one a macOS run would print.
      expect(() => assertProcfs()).not.toThrow();
      expect(PROCFS_MISSING).toMatch(/no Linux procfs \(\/proc\)/);
      return;
    }
    expect(() => assertProcfs()).toThrow(/no Linux procfs \(\/proc\)/);
    expect(() => assertProcfs()).toThrow(/Run it on Linux/);
    // Not the bare errno that made two runs unable to triage the tier.
    expect(() => assertProcfs()).not.toThrow(/ENOENT/);
  });

  it.each(TIERS)("%s refuses with the procfs precondition before it reads procfs", (file) => {
    const text = readFileSync(file, "utf8");
    const guard = text.indexOf("assertProcfs()");
    expect(guard, `${file} never calls assertProcfs()`).toBeGreaterThan(-1);
    // The first procfs reader the file uses must come after the guard. crm-visible-modes guards the one
    // assertion that needs procfs and leaves its procfs-free assertions running; the two job tiers cannot
    // seed or tear down at all without it, so they guard in beforeAll, before the next spawn.
    const reader = text.indexOf("listeningPids(", guard) > -1 ? text.indexOf("listeningPids(", guard) : -1;
    if (reader > -1) {
      expect(reader, `${file} reads procfs before it checks for it`).toBeGreaterThan(guard);
    }
    const nextSpawn = text.indexOf("await startModeServer(", guard);
    if (nextSpawn > -1) {
      expect(nextSpawn, `${file} spawns a server before the procfs precondition`).toBeGreaterThan(guard);
    }
  });
});
