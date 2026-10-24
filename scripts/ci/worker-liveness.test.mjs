// CI tier — THE CHECKER, ON THREE FABRICATED WORKERS AND ONE RECYCLED PID.
//
// The packet behind this: w157 stopped after 9 iterations and wrote no report; the only reason anyone noticed was a
// human comparing `ps` against the packet table. So the tests here are the three verdicts the checker exists to make,
// built from directories rather than from the pool: a running worker (live pid whose command line names its worktree),
// a finished worker (report on disk), and a dead one (pid gone, log carrying both an abort record and a half-written
// tail). The fourth case is the one that made the manual check necessary: a pid file pointing at a LIVE process that
// belongs to somebody else. `kill -0` calls that alive; this checker must not call it RUNNING.
//
// Nothing here touches the harness, a server, the DB or the network: temp dirs, a `node -e` sleeper, and the script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKER = join(ROOT, "scripts/ci/worker-liveness.mjs");

/** A pid that was real and has exited: the state a crashed worker's pid file is left in. */
function gonePid() {
  return spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
}

function runChecker(args, env = {}) {
  // DATABASE_URL is cleared so these packet verdicts cannot depend on how full the local server happens to be.
  return spawnSync(process.execPath, [CHECKER, ...args], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "", ...env },
  });
}

test("without a DATABASE_URL the POOL section says so and changes no packet verdict", () => {
  // The pool census is additive: a caller that was passing before must still pass, and the exit code must
  // stay a packet verdict. What it must NOT do is stay silent — "I did not look" is printed.
  const pool = makePool(["w908"]);
  writeFileSync(join(pool.state, "w908.pid"), `${gonePid()}\n`);
  writeFileSync(join(pool.reports, "W908-REPORT.md"), "# w908\n\nSTATUS: DONE - abc1234\n");
  const skipped = runChecker(state3(pool));
  assert.match(skipped.stdout, /^POOL: skipped — DATABASE_URL is not set/m);
  assert.match(skipped.stdout, /RESULT: OK/);
  assert.equal(skipped.status, 0);

  const help = runChecker(["--help"]);
  assert.match(help.stderr, /--reap-idle\s+OPT-IN and OFF BY DEFAULT/, "the one destructive flag is in --help");
  assert.match(help.stderr, /3 the pool is SATURATED/);
  assert.equal(help.status, 2, "--help is a usage message, and usage is exit 2");
  rmSync(pool.dir, { recursive: true, force: true });
});

function makePool(packets) {
  const dir = mkdtempSync(join(tmpdir(), "sho-worker-liveness-"));
  const state = join(dir, "state");
  const logs = join(dir, "logs");
  const reports = join(dir, "reports");
  for (const each of [state, logs, reports]) mkdirSync(each);
  const tsv = join(dir, "packets.tsv");
  writeFileSync(tsv, `# id\tbranch\tport\tschema\tkeys\n${packets.map((id) => `${id}\tpool/${id}\t3900\t${id}\tOPS`).join("\n")}\n`);
  return { dir, state, logs, reports, tsv };
}

const state3 = (dir) => [
  "--tsv", dir.tsv,
  "--state", dir.state,
  "--logs", dir.logs,
  "--reports", dir.reports,
];

test("three fabricated workers get the three verdicts, and the pool exits non-zero for the dead one", () => {
  const pool = makePool(["w901", "w902", "w903"]);
  // A live process whose command line carries this worker's own worktree, exactly as launch-wave3.sh passes `--cwd`.
  const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", join(pool.dir, "w2-w901")], {
    stdio: "ignore",
  });
  try {
    writeFileSync(join(pool.state, "w901.pid"), `${live.pid}\n`);
    writeFileSync(
      join(pool.logs, "w901.log"),
      '{"ts":"2026-10-23T20:11:22.947Z","type":"agent_event","event":{"type":"iteration_start","iteration":4}}\n',
    );

    writeFileSync(join(pool.state, "w902.pid"), `${gonePid()}\n`);
    writeFileSync(join(pool.reports, "W902-REPORT.md"), "# w902\n\nSTATUS: DONE - deadbeef\n");

    writeFileSync(join(pool.state, "w903.pid"), `${gonePid()}\n`);
    writeFileSync(
      join(pool.logs, "w903.log"),
      [
        '{"ts":"2026-10-23T20:09:30.000Z","type":"agent_event","event":{"type":"iteration_end","iteration":9}}',
        '{"ts":"2026-10-23T20:09:39.477Z","type":"run_aborted","reason":"external_abort","message":"aborted by another client"}',
        '{"ts":"2026-10-23T20:09:39.5', // writer killed mid-line: the truncation the checker looks for
      ].join("\n"),
    );

    const result = runChecker(state3(pool));
    const out = result.stdout;

    assert.match(out, /^w901\s+RUNNING\b/m, "a live pid naming its own worktree is RUNNING");
    assert.match(out, /^w902\s+FINISHED\b/m, "a report on disk is FINISHED");
    assert.match(out, /^w903\s+DEAD-WITHOUT-REPORT\b/m, "pid gone and no report is DEAD-WITHOUT-REPORT");
    assert.match(out, /log abort marker run_aborted/, "the abort record is quoted as evidence");
    assert.match(out, /log ends mid-line/, "the half-written tail is quoted as evidence");
    assert.match(out, /SUMMARY: 1 RUNNING, 1 FINISHED, 1 DEAD-WITHOUT-REPORT of 3 dispatched/);
    assert.match(out, /RESULT: FAIL \(dead without report: w903\)/);
    assert.equal(result.status, 1, "a dead worker must make the checker exit non-zero");
  } finally {
    live.kill();
    rmSync(pool.dir, { recursive: true, force: true });
  }
});

test("a pid file pointing at a live process that is NOT this worker is DEAD, never RUNNING", () => {
  // The failure mode the operator had to rule out by hand: a crashed worker's pid is recycled by any process, and
  // `kill -0` says alive. Here the recycled pid is a live `node -e` sleeper whose command line names ANOTHER worktree.
  const pool = makePool(["w904"]);
  const otherWorker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", join(pool.dir, "w2-w900")], {
    stdio: "ignore",
  });
  try {
    writeFileSync(join(pool.state, "w904.pid"), `${otherWorker.pid}\n`);
    const result = runChecker(state3(pool));
    const line = result.stdout.split("\n").find((each) => each.startsWith("w904")) ?? "";
    assert.match(line, /\bDEAD-WITHOUT-REPORT\b/);
    assert.doesNotMatch(line, /\bRUNNING\b/, "a recycled pid must never read as RUNNING");
    assert.match(line, /reused/);
    assert.equal(result.status, 1);
  } finally {
    otherWorker.kill();
    rmSync(pool.dir, { recursive: true, force: true });
  }
});

test("a relaunched packet is flagged from the wave log, including the log the relaunch overwrote", () => {
  // w157's shape: two LAUNCH lines 156 s apart, one log on disk whose first record is from the SECOND run. The first
  // run's own log was truncated by the relaunch's `> $WORKERS/<id>.log`, which is why its abort record is unrecoverable.
  const pool = makePool(["w905"]);
  const launches = join(pool.dir, "wave.log");
  writeFileSync(
    launches,
    [
      "2026-10-23T20:08:44Z LAUNCH w905 pid=6386 port=3301 schema=w905 keys=OPS",
      "2026-10-23T20:11:20Z LAUNCH w905 pid=36785 port=3301 schema=w905 keys=OPS",
    ].join("\n"),
  );
  writeFileSync(join(pool.state, "w905.pid"), `${gonePid()}\n`);
  writeFileSync(
    join(pool.logs, "w905.log"),
    '{"ts":"2026-10-23T20:11:22.947Z","type":"agent_event","event":{"type":"iteration_start","iteration":1}}\n',
  );
  const result = runChecker([...state3(pool), "--launches", launches]);
  assert.match(result.stdout, /launched 2x \(pid 6386@2026-10-23T20:08:44Z, pid 36785@2026-10-23T20:11:20Z\)/);
  assert.match(result.stdout, /earlier run's log was overwritten by the relaunch/);
  assert.equal(result.status, 1);
  rmSync(pool.dir, { recursive: true, force: true });
});

test("a pool where every packet finished exits zero", () => {
  // Guards against a checker that always fails - a gate nobody can pass is not a gate.
  const pool = makePool(["w906", "w907"]);
  for (const id of ["w906", "w907"]) {
    writeFileSync(join(pool.state, `${id}.pid`), `${gonePid()}\n`);
    writeFileSync(join(pool.reports, `${id.toUpperCase()}-REPORT.md`), `# ${id}\n\nSTATUS: DONE - abc1234\n`);
  }
  const result = runChecker(state3(pool));
  assert.match(result.stdout, /SUMMARY: 0 RUNNING, 2 FINISHED, 0 DEAD-WITHOUT-REPORT of 2 dispatched/);
  assert.match(result.stdout, /RESULT: OK/);
  assert.equal(result.status, 0);
  rmSync(pool.dir, { recursive: true, force: true });
});
