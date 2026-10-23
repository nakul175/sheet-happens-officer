// W152 (CI): the SIGTERM drain files are Linux-only, so they live in the Linux tier and nowhere else.
//
// tests/shutdown-next.test.ts spawns `taskset` and reads /proc/<pid>/status and /proc/<pid>/limits; the
// seven SIGTERM-drain tests in tests/shutdown.test.ts expect exit 0 and the clean-drain line, which
// src/lib/shutdown.ts produces only when the Linux accept-queue seizer is loaded (loadNative and
// loadLibc return null off linux, src/lib/shutdown.ts:205 and :246). Neither can pass on darwin, so
// before this guard they made `npm test` on darwin red for a reason unrelated to the change under test,
// while tests/shutdown-next.test.ts's own header claimed `npm test` excluded it.
//
// The trap this file closes is the W96 one: a file that is excluded from the default tier and included
// by no other tier runs nowhere, and every offline run stays green. So both halves are asserted here —
// out of `npm test`, in the Linux config, and that config is the one ci.yml runs on ubuntu-latest. This
// file itself is collected by `npm test` (it is not in the exclude list), so it cannot be dropped
// without a red run.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const LINUX_ONLY = ["tests/shutdown.test.ts", "tests/shutdown-next.test.ts"] as const;

/** The entries of one `key: [ ... ]` list, read off the config text (no import side effects).
 *  Only lines that ARE an entry count: a name quoted inside a comment must not satisfy the guard —
 *  the first version of this file parsed those too and passed with the exclude entries commented out. */
function listEntries(configName: string, key: "include" | "exclude"): string[] {
  const source = readFileSync(path.join(ROOT, configName), "utf8");
  const match = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (!match) throw new Error(`${configName} has no ${key} list`);
  return [...match[1].matchAll(/^[ \t]*["']([^"']+)["'][ \t]*,?[ \t]*$/gm)].map((entry) => entry[1]);
}

describe("W152 tier placement: the Linux-only SIGTERM drain files", () => {
  it("npm test does not collect them, and names each one instead of globbing tests/shutdown*-", () => {
    const excluded = listEntries("vitest.config.mts", "exclude");
    for (const file of LINUX_ONLY) expect(excluded, `${file} is excluded from npm test by name`).toContain(file);
    // A glob would also hide files written later; the two names above are the whole exclusion.
    expect(excluded.filter((entry) => entry.includes("shutdown"))).toEqual([...LINUX_ONLY]);
  });

  it("the Linux tier collects them, so they cannot drop out of every tier", () => {
    const included = listEntries("vitest.shutdown.config.mts", "include");
    for (const file of LINUX_ONLY) {
      expect(included, `${file} is in vitest.shutdown.config.mts`).toContain(file);
      // A rename or a delete would otherwise shrink the tier to nothing without any red run.
      expect(existsSync(path.join(ROOT, file)), `${file} exists`).toBe(true);
    }
    // The include list is exact: no pattern here can silently pick up a file that needs darwin.
    for (const entry of included) expect(entry).not.toContain("*");
  });

  it("CI runs that tier on Linux, before it starts the app", () => {
    const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci, "a ci.yml step runs the Linux tier's config").toContain("-c vitest.shutdown.config.mts");
    expect(ci, "the job that runs it is ubuntu-latest").toMatch(/runs-on: ubuntu-latest/);
    // "run: npm test" is the unit step; the bare phrase also appears in ci.yml's header comment.
    expect(ci.indexOf("vitest.shutdown.config.mts"), "the tier runs before the unit step")
      .toBeLessThan(ci.indexOf("run: npm test"));
  });

  it("the exclusion is justified by the files themselves", () => {
    // If either file is ever ported to run on darwin, this fails and the exclusion has to be revisited
    // rather than quietly staying in place.
    const next = readFileSync(path.join(ROOT, "tests/shutdown-next.test.ts"), "utf8");
    expect(next).toContain('spawn("taskset"');
    expect(next).toContain("/proc/${pid}/status");
    const drain = readFileSync(path.join(ROOT, "tests/shutdown.test.ts"), "utf8");
    expect(drain).toContain("CLEAN_LOG");
    // The file already records the darwin divergence for its F7 test; the seven drain tests assert the
    // Linux outcome that comment describes.
    expect(drain).toContain("the koffi accept-queue seizer is linux-only");
  });
});
