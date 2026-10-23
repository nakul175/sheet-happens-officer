// OPERATOR TIER — THE LAUNCHER MUST REFUSE TO START A SECOND CLIENT ON A LIVE WORKER'S DATA-DIR.
//
// The incident: w157, w197 and w213 each ended with
//   run_aborted reason=external_abort message="aborted by another client"
// and wrote no report. `external_abort` is the message the CLI prints ONLY when its session was ended by a client
// that was not itself (not `local_abort` from SIGINT, not `aborted after timeout`). Two clients were therefore
// attached to one `<id>-data` session store. launch-wave3.sh had no liveness check at all, so relaunching an id
// whose pid file still pointed at the running worker started exactly that second client.
//
// These tests drive the real launcher (`bash launch-wave3.sh launch`) against a fabricated pool: a temp
// workers dir, a one-line TSV, a fabricated PREP_OK log, and a stub standing in for the `cline` binary so the
// launch is observable but costs no model call and touches no session store.
//
// The launcher is part of the untracked harness (cline-team/.local/workers), so the path is given explicitly:
//   SHO_LAUNCH_WAVE3=/path/to/launch-wave3.sh node --test scripts/ci/launch-guard.test.mjs
// Without it the file skips rather than guessing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCHER = process.env.SHO_LAUNCH_WAVE3 ?? "";
const skip = LAUNCHER === "" ? "set SHO_LAUNCH_WAVE3 to the launcher under test" : false;

/** A pid that was real and has exited: the state a crashed worker's pid file is left in. */
function gonePid() {
  return spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
}

/** A live process whose command line names `marker` — a worker-shaped process, or somebody else's. */
function sleeperNaming(marker) {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", marker], { stdio: "ignore" });
}

/**
 * A fabricated pool: the launcher reads only these paths. `id` gets a worktree at /tmp/w2-<id> because the launch
 * subshell `cd`s into it, and a PREP_OK line because `launch` mode skips ids whose prep failed.
 */
function makePool(id) {
  const dir = mkdtempSync(join(tmpdir(), "launch-guard-"));
  const workers = join(dir, "workers");
  const w2 = join(workers, "wave3");
  const state = join(w2, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(w2, "outbox"), { recursive: true });

  const stub = join(dir, "cline-stub");
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$SHO_STUB_MARKER"\nexit 0\n`);
  chmodSync(stub, 0o755);

  writeFileSync(join(w2, `${id}.task`), "PACKET (OPS) fabricated task for the launch guard test\n");
  writeFileSync(join(w2, `prep-${id}.log`), `PREP_OK ${id} port=3399 schema=${id} cwd=/tmp/w2-${id}\n`);
  writeFileSync(join(w2, "wave3.tsv"), `${id}\tpool/w6c-guard\t3399\t${id}\tOPS\n`);
  mkdirSync(`/tmp/w2-${id}`, { recursive: true });

  return {
    id,
    dir,
    workers,
    w2,
    state,
    stub,
    marker: join(dir, "stub-args"),
    pidfile: join(state, `${id}.pid`),
    waveLog: join(w2, "wave3.log"),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
      rmSync(`/tmp/w2-${id}`, { recursive: true, force: true });
    },
  };
}

function runLauncher(pool) {
  const result = spawnSync("bash", [LAUNCHER, "launch"], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      WORKERS: pool.workers,
      W2: pool.w2,
      STATE: pool.state,
      // TSV is exported in a pool worker's shell, and the launcher honours it, so the fabricated table is pinned
      // explicitly: inheriting the real one would launch the real pool from a test.
      TSV: join(pool.w2, "wave3.tsv"),
      BASE: "deadbee",
      CLINE: pool.stub,
      SHO_STUB_MARKER: pool.marker,
    },
  });
  return { ...result, wave: existsSync(pool.waveLog) ? readFileSync(pool.waveLog, "utf8") : "" };
}

/** The launch subshell is backgrounded by the launcher, so the stub's write has to be waited for. */
async function waitForMarker(marker, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(marker)) return readFileSync(marker, "utf8");
    await new Promise((each) => setTimeout(each, 50));
  }
  return "";
}


test("a relaunch while the worker's own process is alive is REFUSED, and no second client is started", { skip }, async () => {
  // w157's shape: LAUNCH w157 pid=6386 at 20:08:44Z, LAUNCH w157 pid=36785 at 20:11:20Z, same port, same schema,
  // same --data-dir. The second client aborted the first. The guard must stop the second launch.
  const pool = makePool("w9001");
  const live = sleeperNaming(`/tmp/w2-${pool.id}`);
  try {
    writeFileSync(pool.pidfile, `${live.pid}\n`);
    const result = runLauncher(pool);
    assert.match(result.stderr, new RegExp(`LAUNCH_REFUSED ${pool.id}: pid ${live.pid} is still running this worker`));
    assert.match(result.wave, new RegExp(`LAUNCH_REFUSED ${pool.id} pid=${live.pid} still alive`));
    assert.doesNotMatch(result.wave, new RegExp(` LAUNCH ${pool.id} `), "the launcher must not start a second client");
    assert.equal(existsSync(pool.marker), false, "the cline binary must never be invoked for a live worker");
    // `LAUNCHED:` counts pid files, and a refused worker still has one, so the refusal must be counted separately
    // or a refused launch reads exactly like a launched one.
    assert.match(result.stderr, new RegExp(`REFUSED: 1 launch\\(es\\) not started, worker still alive: ${pool.id}`));
  } finally {
    live.kill();
    pool.cleanup();
  }
});

test("the same refusal when the command line names the data-dir rather than the worktree", { skip }, async () => {
  // The guard accepts either identity because the launcher passes both: --cwd /tmp/w2-<id> and
  // --data-dir <workers>/<id>-data. A process started with only the data-dir named is still that worker.
  const pool = makePool("w9002");
  const live = sleeperNaming(join(pool.workers, `${pool.id}-data`));
  try {
    writeFileSync(pool.pidfile, `${live.pid}\n`);
    const result = runLauncher(pool);
    assert.match(result.stderr, new RegExp(`LAUNCH_REFUSED ${pool.id}`));
    assert.equal(existsSync(pool.marker), false);
  } finally {
    live.kill();
    pool.cleanup();
  }
});

test("a pid that has exited does not block the launch", { skip }, async () => {
  // The ordinary relaunch after a crash: the pid file is stale, the worker is gone, the launch must proceed.
  const pool = makePool("w9003");
  try {
    writeFileSync(pool.pidfile, `${gonePid()}\n`);
    const result = runLauncher(pool);
    assert.match(result.wave, new RegExp(` LAUNCH ${pool.id} pid=\\d+ port=3399 schema=${pool.id}`));
    const args = await waitForMarker(pool.marker);
    assert.match(args, /--data-dir/, "a dead worker's pid must not stop the relaunch");
    assert.match(args, new RegExp(`${pool.id}-data`));
    assert.doesNotMatch(result.stderr, /REFUSED:/, "a launch that went ahead must not be counted as refused");
  } finally {
    pool.cleanup();
  }
});

test("a pid REUSED by an unrelated command does not block the launch - and is logged as reuse", { skip }, async () => {
  // The check `kill -0` cannot make: a crashed worker's pid is recycled by anything, and the pid file still names it.
  // Here the live process belongs to ANOTHER worktree, so it is not this worker and must not stop the launch.
  const pool = makePool("w9004");
  const other = sleeperNaming("/tmp/w2-w9000");
  try {
    writeFileSync(pool.pidfile, `${other.pid}\n`);
    const result = runLauncher(pool);
    assert.match(result.wave, new RegExp(`LAUNCH_REUSE ${pool.id} pid=${other.pid} alive but is not this worker`));
    assert.match(result.wave, new RegExp(` LAUNCH ${pool.id} pid=\\d+`));
    assert.doesNotMatch(result.stderr, /LAUNCH_REFUSED/);
    assert.notEqual(await waitForMarker(pool.marker), "", "a recycled pid must not block the launch");
  } finally {
    other.kill();
    pool.cleanup();
  }
});
