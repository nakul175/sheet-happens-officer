// SHO-2897: missing/shared/unreadable inherited outboxes never skip the story.
// The spec creates its own private directory and starts its actual app writer there.
// These cheap gate probes deliberately omit owned-app configuration: they must fail setup,
// not silently skip. The only legitimate skip is a missing SHO_QA_PASS.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const SPEC = "tests/e2e/stories/APL-2609.spec.ts";
const BIN = path.join(root, "node_modules", ".bin", "playwright");
const TIMEOUT = 180_000;

type Annotation = { type: string; description?: string };
type Outcome = { title: string; annotations: Annotation[]; statuses: string[] };
type Report = { suites?: Suite[] };
type Suite = { specs?: { title: string; tests?: { annotations?: Annotation[]; results?: { status: string }[] }[] }[]; suites?: Suite[] };

/** Every spec in a Playwright JSON report, with the annotations and result statuses of its first test. */
function outcomes(report: Report): Outcome[] {
  const out: Outcome[] = [];
  const walk = (s: Suite) => {
    for (const spec of s.specs ?? []) {
      const test = spec.tests?.[0];
      out.push({ title: spec.title, annotations: test?.annotations ?? [], statuses: (test?.results ?? []).map((r) => r.status) });
    }
    for (const child of s.suites ?? []) walk(child);
  };
  for (const s of report.suites ?? []) walk(s);
  return out;
}

/** One real `playwright test` run of the APL-2609 spec, with the outbox configured exactly as the case needs. */
function run(outbox: string | undefined, qaPass = "w13-gate-probe-pass"): Outcome[] {
  const env: NodeJS.ProcessEnv = { ...process.env, TASKBOARD_URL: "http://127.0.0.1:9", SHO_QA_PASS: qaPass };
  delete env.EMAIL_OUTBOX_DIR;
  delete env.SHO_QA_APP_ROOT;
  delete env.SHO_QA_RELEASE;
  delete env.BASE_URL;
  delete env.STAGING_URL;
  if (outbox !== undefined) env.EMAIL_OUTBOX_DIR = outbox;
  const outputDir = mkdtempSync(path.join(tmpdir(), "sho-2897-gate-"));
  try {
    const r = spawnSync(BIN, ["test", SPEC, "--reporter=json", `--output=${outputDir}`], { cwd: root, env, encoding: "utf8", timeout: TIMEOUT });
    const stdout = r.stdout ?? "";
    const start = stdout.indexOf("{");
    expect(start, `playwright printed no JSON report:\n${stdout}\n${r.stderr ?? ""}`).toBeGreaterThanOrEqual(0);
    return outcomes(JSON.parse(stdout.slice(start)) as Report);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

/** The skips this spec makes because of its outbox gate, as opposed to a serial run's "did not run". */
const outboxSkips = (list: Outcome[]) =>
  list.flatMap((o) => o.annotations.filter((a) => a.type === "skip" && (a.description ?? "").includes("EMAIL_OUTBOX_DIR")));

/** Whether the first test actually started against the server (it fails on the unreachable port, it does not skip). */
const attempted = (list: Outcome[]) => list.some((o) => o.statuses.some((s) => s === "failed" || s === "timedOut"));

describe("SHO-2897: only the missing QA password can skip the story", () => {
  it("skips every case with a password reason when SHO_QA_PASS is missing", () => {
    const list = run(undefined, "");
    expect(list).toHaveLength(4);
    expect(list.map(o => o.statuses)).toEqual([["skipped"], ["skipped"], ["skipped"], ["skipped"]]);
    for (const o of list) expect(o.annotations.some(a => a.type === "skip" && a.description?.includes("SHO_QA_PASS"))).toBe(true);
  }, TIMEOUT);

  for (const shape of ["unset", "missing", "file", "directory"] as const) {
    it(`does not skip with an inherited ${shape} outbox; missing owned-app setup fails`, () => {
      const temp = mkdtempSync(path.join(tmpdir(), "sho-2897-gate-input-"));
      try {
        const file = path.join(temp, "not-a-directory");
        if (shape === "file") writeFileSync(file, "");
        const input = shape === "unset" ? undefined : shape === "missing" ? path.join(temp, "absent") : shape === "file" ? file : temp;
        const list = run(input);
        expect(list).toHaveLength(4);
        expect(outboxSkips(list)).toEqual([]);
        expect(attempted(list), "a setup failure must be reported rather than hidden by a skip").toBe(true);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }, TIMEOUT);
  }
});
