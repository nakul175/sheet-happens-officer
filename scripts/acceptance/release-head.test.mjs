// SHO-2689 / W204 — the checkout must BE the release the receipt names.
//
// WHY THIS FILE EXISTS
// The gate's in-scope threats are the ones its conditions enforce (header "LIMITS"): the wrong
// platform, a dev build, an unbuilt tree, a mismatched release, and a burst off the pinned
// protocol. All but one had a test; the mismatched release had HALF a test:
//
//   - the release /api/health echoes -> c0-release, driven from a fixture document in
//     linux-drain-gate.test.mjs (a built tree whose health names a different sha);
//   - the TREE UNDER TEST -> main() asks git whether HEAD is the sha on the command line and
//     prints `GATE=FAIL release-head-mismatch`. That line exists only inside main(), and this
//     host refuses in main() before it can reach it, so no test could see it. A gate whose
//     identity condition is only reachable inside a real Linux run is exactly the shape that
//     shipped broken before (the harness-sigterm-40ms pin), so it is driven here.
//
// HOW: the same sourcing seam the rest of the suite uses. `platform_is_linux` is redefined in the
// CALLING shell — never in the file — so main() takes its Linux branch and reaches its argument
// guards. This is a SIMULATION of the Linux branch, not acceptance (only a real Linux kernel can
// produce the receipt), and it starts nothing: a mismatched sha returns before TMP, before
// prepare_build_root and before the first socket, and the control is pointed at an empty
// GATE_BUILD_ROOT so its precondition fails instead of building.
//
// Run with: node --test "scripts/acceptance/**/*.test.mjs"
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./linux-drain-gate.sh", import.meta.url));
const ROOT = path.resolve(path.dirname(script), "..", "..");
const HEAD = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

// Never a real database url: the sentinel only proves the gate does not print it.
const SENTINEL_DB = "postgresql://sentinel-never-printed/db";
const NOT_HEAD = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

/** main() on a simulated Linux kernel, with `platform_is_linux` redefined in this shell. */
function simulatedMain(args, env = {}) {
  return spawnSync(
    "bash",
    ["-c", 'source "$1"; shift; platform_is_linux() { return 0; }; main "$@"', "--", script, ...args],
    { encoding: "utf8", env: { ...process.env, GATE_RUNS: "1", ...env } },
  );
}

test("main() refuses a sha that is not the checkout's HEAD, before any build", () => {
  assert.match(HEAD, /^[0-9a-f]{40}$/, `this checkout must have a HEAD (got ${JSON.stringify(HEAD)})`);

  const out = simulatedMain(["--production", NOT_HEAD], { DATABASE_URL: SENTINEL_DB });

  assert.equal(out.status, 1, `exit code\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`);
  assert.match(
    out.stdout,
    new RegExp(`^GATE=FAIL release-head-mismatch \\(requested ${NOT_HEAD}, HEAD is ${HEAD}\\)$`, "m"),
    `the mismatch is named with both shas:\n${out.stdout}`,
  );
  assert.ok(!/^BUILD=/m.test(out.stdout), `no build was attempted:\n${out.stdout}`);
  assert.ok(!/^RUN \d/m.test(out.stdout), `no burst was run:\n${out.stdout}`);
  assert.ok(!/GATE=PASS/.test(out.stdout), "a mismatched tree must never pass");
  assert.ok(!out.stdout.includes(SENTINEL_DB), "the database url is never printed");
});

test("control: the checkout's own HEAD passes that guard, so the case above is not vacuous", () => {
  // No DATABASE_URL is needed here: the precondition on an empty root fails first.
  const empty = mkdtempSync(path.join(tmpdir(), "sho-gate-head-ok-"));
  try {
    const out = simulatedMain(["--production", HEAD.slice(0, 12)], {
      GATE_BUILD_ROOT: empty,
      DATABASE_URL: SENTINEL_DB,
    });
    assert.ok(!out.stdout.includes("release-head-mismatch"), `HEAD is the release it named:\n${out.stdout}`);
    assert.match(out.stdout, /^GATE=MODE mode=production$/m, "main got past its argument guards");
    assert.match(out.stdout, new RegExp(`^RELEASE=${HEAD.slice(0, 12)}$`, "m"));
    // An abbreviated sha is accepted by the same 7-character rule c0-release uses, and the run
    // then stops on the empty root rather than starting a build.
    assert.match(out.stdout, /^GATE=FAIL missing-production-entry \(/m, out.stdout);
    assert.ok(!/^BUILD=ok/m.test(out.stdout), "nothing was built");
    assert.ok(!/^RUN \d/m.test(out.stdout), "nothing was measured");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
