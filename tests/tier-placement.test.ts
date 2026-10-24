// W152 (CI), rewritten by W163: the SIGTERM drain work is in two tiers, and this file is the guard
// that neither half can be lost silently.
//
//   * tests/shutdown-next.test.ts is Linux-only whole — it spawns `taskset`, reads
//     /proc/<pid>/status and /proc/<pid>/limits, and runs `next build`, which would rewrite .next
//     under the app the CI job already started. It is named out of `npm test` and into
//     vitest.shutdown.config.mts.
//   * tests/shutdown.test.ts is mixed. Seven of its cases assert exit 0 and CLEAN_LOG, which
//     src/lib/shutdown.ts produces only where the Linux accept-queue seizer loaded (loadNative and
//     loadLibc return null off linux, src/lib/shutdown.ts:205 and :246), so they gate themselves with
//     `it.skipIf(process.platform !== "linux")`. The other seven — the drain-clock env parsing, the
//     shared Prisma client, the timeout path and the F7 alias cases — run on every OS, so the file
//     stays in `npm test`. W152 excluded the whole file, which was green on darwin because it had
//     deleted those seven cases from the default run; W163 put the file back and gated the cases.
//
// The trap this file closes is the W96 one: a file excluded from the default tier and included by no
// other tier runs nowhere, and every offline run stays green. Both halves are asserted here — the
// mixed file is NOT excluded and IS collected by the Linux tier too, so the seven skipped-on-darwin
// cases still run for real on ubuntu-latest; the whole-Linux file is out of `npm test` and in that
// tier. This file itself is collected by `npm test` (it is not in the exclude list), so it cannot be
// dropped without a red run.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DRAIN_SPEC = "tests/shutdown.test.ts"; // mixed: 7 darwin-safe cases + 7 Linux-only ones
const LINUX_ONLY = [DRAIN_SPEC, "tests/shutdown-next.test.ts"] as const;

/** The entries of one `key: [ ... ]` list, read off the config text (no import side effects).
 *  Only lines that ARE an entry count: a name quoted inside a comment must not satisfy the guard —
 *  the first version of this file parsed those too and passed with the exclude entries commented out. */
function listEntries(configName: string, key: "include" | "exclude"): string[] {
  const source = readFileSync(path.join(ROOT, configName), "utf8");
  const match = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (!match) throw new Error(`${configName} has no ${key} list`);
  return [...match[1].matchAll(/^[ \t]*["']([^"']+)["'][ \t]*,?[ \t]*$/gm)].map((entry) => entry[1]);
}

/** Every `it(...)` site in a spec, with its header line and the text up to the next `it(`.
 *  The file is flat, so "up to the next it(" is that case's own body — enough to tell which
 *  assertions it owns without parsing TypeScript. */
function testCases(source: string): { header: string; body: string }[] {
  const starts = [...source.matchAll(/^[ \t]*it(\.\w+(?:\([^)]*\))?)?\(/gm)];
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const next = index + 1 < starts.length ? (starts[index + 1].index ?? source.length) : source.length;
    const lineEnd = source.indexOf("\n", start);
    // The whole header line: the titles are long and the skip reason sits at their end.
    return { header: source.slice(start, lineEnd === -1 ? source.length : lineEnd), body: source.slice(start, next) };
  });
}

describe("W152/W163 tier placement: the SIGTERM drain files", () => {
  it("npm test still collects tests/shutdown.test.ts, and names only shutdown-next.test.ts out", () => {
    const excluded = listEntries("vitest.config.mts", "exclude");
    // W163: excluding this file bought a green darwin run by deleting seven platform-independent
    // cases from `npm test`. Re-adding the entry has to be a red run, not a quiet edit.
    expect(excluded, `${DRAIN_SPEC} is not excluded from npm test`).not.toContain(DRAIN_SPEC);
    // A glob would also hide files written later; the one name below is the whole exclusion.
    expect(excluded.filter((entry) => entry.includes("shutdown"))).toEqual(["tests/shutdown-next.test.ts"]);
  });

  it("every case in the drain spec that asserts the clean-drain exit is gated by it.skipIf", () => {
    const source = readFileSync(path.join(ROOT, DRAIN_SPEC), "utf8");
    // The gate is not a comment: `npm test` on darwin fails on any of these seven that runs ungated
    // (exit 1 / TIMEOUT_LOG instead of 0 / CLEAN_LOG), so an ungated case is a red default tier.
    expect(source, "the platform gate").toContain('const LINUX_ONLY = process.platform !== "linux"');
    // A bare "(skipped)" tells a darwin reader nothing, so each skipped title carries the reason.
    expect(source, "the skip reason is on the title").toContain("const SKIP_REASON = LINUX_ONLY");
    expect(source).toContain("${SKIP_REASON}`");
    const drainCases = testCases(source).filter((c) =>
      /expect\(result\.code\)\.toBe\(0\)|toEqual\(\[CLEAN_LOG\]\)/.test(c.body),
    );
    expect(drainCases.length, "cases asserting exit 0 / CLEAN_LOG").toBe(7);
    for (const testCase of drainCases) {
      expect(testCase.header, `${testCase.header.trim()} is gated with it.skipIf(LINUX_ONLY)`).toContain(
        "it.skipIf(LINUX_ONLY)",
      );
      expect(testCase.header, `${testCase.header.trim()} carries the skip reason`).toContain("${SKIP_REASON}");
    }
    // And nothing else skips: the file must not creep back to "skip it all on darwin".
    const gated = testCases(source).filter((c) => c.header.includes("it.skipIf"));
    expect(gated.length, "exactly the seven Linux-only cases skip").toBe(drainCases.length);
  });

  it("the Linux tier collects both files, so the skipped cases still run on ubuntu", () => {
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
    // W174: anchor the order on the STEPS, not on the first mention of either string. `indexOf` of a
    // bare phrase is satisfied by a comment — ci.yml's header comment already carries "run: npm test",
    // and a comment naming vitest.shutdown.config.mts above it made the previous version of this
    // assertion pass with the drain step moved after the unit step.
    const drainStep = ci.indexOf("- name: SIGTERM drain tests");
    const unitStep = ci.indexOf("- name: Unit tests");
    expect(drainStep, "ci.yml still has a SIGTERM drain step").toBeGreaterThan(-1);
    expect(unitStep, "ci.yml still has a Unit tests step").toBeGreaterThan(-1);
    expect(drainStep, "the tier runs before the unit step").toBeLessThan(unitStep);
    // And that step is the thing that runs the config: the name may not live only in a comment.
    expect(ci.slice(drainStep, unitStep), "the drain step runs the tier's config")
      .toContain("-c vitest.shutdown.config.mts");
  });

  it("the exclusion is justified by the file that is excluded", () => {
    // If shutdown-next.test.ts is ever ported to run on darwin it comes out of the exclude list and
    // off this assertion; if it is only half-ported, this fails instead of the exclusion quietly
    // staying. The drain spec's darwin divergence lives in its header and in SKIP_REASON.
    const next = readFileSync(path.join(ROOT, "tests/shutdown-next.test.ts"), "utf8");
    expect(next).toContain('spawn("taskset"');
    expect(next).toContain("/proc/${pid}/status");
    const drain = readFileSync(path.join(ROOT, DRAIN_SPEC), "utf8");
    expect(drain).toContain("CLEAN_LOG");
    expect(drain).toContain("loadNative/loadLibc return null off linux");
  });
});
