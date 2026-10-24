import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { refusalAccepted } from "./refusal-probe.mjs";

assert.equal(process.platform, "linux", "SHO-2760 acceptance requires the Linux built entry");
const sha = process.env.RELEASE;
assert.match(sha || "", /^[a-f0-9]{40}$/);
const receipt = { bug: "SHO-2760", release: sha, acceptedLimitMs: 1200, runs: [], result: "PASS" };
for (let run = 1; run <= 5; run++) {
  const result = spawnSync(process.execPath, ["scripts/drain-burst.mjs", "100", "0", "--production", "--slow", "--assert"], {
    env: { ...process.env, SHO_APP_ROOT: process.cwd(), SHO_ENTRY: "server.js", BURST_SIGTERM_DELAY_MS: "40" },
    encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const r = JSON.parse(result.stdout);
  assert.equal(r.release, sha);
  assert.equal(r.serving.entry, "server.js");
  assert.equal(r.serving.nodeEnv, "production");
  assert.equal(r.serving.buildId, "present");
  assert.equal(r.serving.devArtifacts, false);
  assert.equal(r.stillOpenAtSigterm, 100);
  assert.equal(r.inFlight.bodyDone, 100);
  assert.equal(r.inFlight.non200, 0);
  assert.equal(r.exit.code, 0);
  assert.equal(r.drainedLine, "logged");
  assert.ok(refusalAccepted(r.refusalTiming.late16));
  assert.ok(refusalAccepted(r.refusalTiming.late143));
  receipt.runs.push({ run, url: r.listenerUrl, all100Responses200: true, drained: true, exit: 0, late16: r.refusalTiming.late16, late143: r.refusalTiming.late143 });
}
receipt.maxRefusalMs = Math.max(...receipt.runs.flatMap(r => [r.late16.elapsedMs, r.late143.elapsedMs]));
writeFileSync(process.argv[2] || "release12-drain.json", JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt));
