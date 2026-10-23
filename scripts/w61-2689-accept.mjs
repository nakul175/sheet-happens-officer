#!/usr/bin/env node
// SHO-2689 — COMPLETE ACCEPTANCE RUNNER (W61).
//
// One self-contained runner for the SIGTERM-drain acceptance SHO-2689 has been waiting for:
// drain numbers, refused-probe accounting, disconnect/teardown proof, exit code and the
// `release` SHA echoed by /api/health — measured, not inferred from a log line.
//
// It refuses to report PASS for anything it did not measure: every leg carries
// PASS / FAIL / NOT-MEASURED, and the run is PASS only when every leg is PASS.
//
// Two ways to get a server under the knife:
//
//   owned (default) — the runner starts the real production entry itself (`node server.js`,
//                     the systemd ExecStart of deploy/cloud-init.yaml), keeps its stdout/stderr,
//                     and therefore owns the exit code (F9: a pid-1 orphan has no observable
//                     exit status, so the acceptance never relies on one).
//
//   adopt           — the server is already running: --pid <pid> plus --log <app log file>.
//                     The exit code is only observable through --exit-code-file, e.g.
//                       setsid nohup bash -c 'bin/serve9.sh >> APP.log 2>&1; echo $? > /tmp/x.code'
//                     Without it the exit-code leg is NOT-MEASURED and the verdict cannot be PASS (F9).
//
// Usage (nothing secret is printed; DATABASE_URL comes from the environment):
//   RELEASE=<sha> DATABASE_URL='postgresql://...?schema=<slot>' \
//     node scripts/w61-2689-accept.mjs --base-url http://127.0.0.1:3183 --sha <sha>
//   node scripts/w61-2689-accept.mjs --base-url http://127.0.0.1:3109 --sha <sha> \
//     --mode adopt --pid 3700282 --log /home/deploy/preview/pr9/app-391fb96.log \
//     --exit-code-file /tmp/sho2689/exit.code
//
// Exit codes: 0 PASS · 1 FAIL · 2 INCOMPLETE (a leg was not measured) · 3 harness error ·
//             4 SHA mismatch (fails loudly before any burst is issued).

import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLEAN_LOG = "graceful shutdown: drained in-flight requests";
const TIMEOUT_LOG = "graceful shutdown: drain timed out";
const DISCONNECT_FAILED = "prisma disconnect failed:";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = "true";
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const mode = opts.mode === "adopt" ? "adopt" : "owned";
const baseUrl = (opts["base-url"] || "http://127.0.0.1:3000").replace(/\/$/, "");
const expectedSha = opts.sha || "";
const bursts = String(opts.bursts || "40,100")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isInteger(v) && v > 0);
const httpPath = opts.path || "/api/health";
const preMs = Number(opts["pre-ms"] || 40);
const probeOffsets = [16, 143, 400, 900];
const probeTimeoutMs = Number(opts["probe-timeout-ms"] || 500);
const readTimeoutMs = Number(opts["read-timeout-ms"] || 30_000);
const drainWindowMs = Number(opts["drain-window-ms"] || 15_000);
const stopWindowMs = Number(opts["stop-window-ms"] || 90_000);
const connectTimeoutMs = Number(opts["connect-timeout-ms"] || 5_000);
const entry = opts.entry || "server.js";
const disconnectMode = opts.disconnect === "skip" ? "skip" : "probe";
const disconnectPort = Number(opts["disconnect-port"] || 0) || 0;
const holdMs = Number(opts["disconnect-hold-ms"] || 5_000);
const nodeEnv = opts["node-env"] || "development";

const url = new URL(baseUrl);
const host = url.hostname;
const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));

const t00 = Date.now();
const stamp = () => Date.now() - t00;
const say = (line) => process.stdout.write(`${line}\n`);


// ---------------------------------------------------------------- transport

function connectOnce(timeoutMs = connectTimeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      done({ ok: false, error: "TIMEOUT" });
    }, timeoutMs);
    socket.setNoDelay(true);
    socket.once("connect", () => done({ ok: true, socket }));
    socket.once("error", (err) => {
      socket.destroy();
      done({ ok: false, error: err.code || err.message });
    });
  });
}

function classifyBytes(buf) {
  if (buf.startsWith("HTTP/")) return { kind: "response", status: Number(buf.split(" ")[1]) };
  return { kind: buf === "" ? "reset" : "garbage" };
}

// Read one accepted socket to close. Bytes that never start with "HTTP/" are a dropped
// request (`reset`), never a completed one — BUG-2689-LINUX.md §9.3.
function readToClose(socket) {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...classifyBytes(buf), bytes: Buffer.byteLength(buf), ...extra });
    };
    const timer = setTimeout(() => finish({ timedOut: true }), readTimeoutMs);
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
    });
    socket.once("close", () => finish({}));
    socket.once("end", () => finish({}));
    socket.once("error", () => finish({ errored: true }));
  });
}

async function httpGet(pathname) {
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl}${pathname}`, { signal: AbortSignal.timeout(connectTimeoutMs) });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, body: null, ms: Date.now() - started, error: err.code || err.message };
  }
}

// A SYN that neither connects nor is refused inside the budget is `hung` (a dropped SYN),
// never `refused` — BUG-2689-LINUX.md §6 criterion (b).
function probe(budgetMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(verdict);
    };
    const timer = setTimeout(() => done("hung"), budgetMs);
    socket.setNoDelay(true);
    socket.once("connect", () => done(`accepted+${Date.now() - started}ms`));
    socket.once("error", (err) => done(err.code === "ECONNREFUSED" ? "refused" : err.code || "error"));
  });
}

// ---------------------------------------------------------------- target: owned / adopt

function startOwned(runPort, extraEnv = {}, preload = []) {
  const env = {
    ...process.env,
    NODE_ENV: nodeEnv,
    PORT: String(runPort),
    SHO_BIND_HOST: host,
    NEXT_TELEMETRY_DISABLED: "1",
    ...extraEnv,
  };
  const argv = [...preload.flatMap((mod) => ["--require", mod]), entry];
  const child = spawn(process.execPath, argv, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  const onLine = (side) => (chunk) => {
    for (const raw of chunk.toString().split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      lines.push({ at: stamp(), side, line });
      if (opts.verbose === "true") say(`[${String(stamp()).padStart(6)}ms ${side}] ${line}`);
    }
  };
  child.stdout.on("data", onLine("out"));
  child.stderr.on("data", onLine("err"));
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal, at: stamp() }));
  });
  return { child, lines, exited, pid: child.pid, owned: true };
}

function adoptTarget() {
  const pid = Number(opts.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("--mode adopt requires --pid");
  const logFile = opts.log;
  if (!logFile) throw new Error("--mode adopt requires --log <app log file> (drain lines are read from it)");
  return { pid, logFile, owned: false, lines: [] };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logSize(logFile) {
  try {
    return fs.statSync(logFile).size;
  } catch {
    return null;
  }
}

function readAppended(logFile, offset) {
  try {
    const fd = fs.openSync(logFile, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return "";
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null; // unreadable => NOT-MEASURED, never "no drain line"
  }
}

async function waitFor(check, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    if (check()) return true;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const legs = [];
function leg(id, status, detail, evidence) {
  legs.push({ id, status, detail, ...(evidence === undefined ? {} : { evidence }) });
}

// ---------------------------------------------------------------- one burst + drain run

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOne(n) {
  const runPort = port; // sequential: the previous run has exited before the next one binds
  const result = {
    n,
    startedAt: new Date().toISOString(),
    mode,
    target: baseUrl,
    httpPath,
    preMs,
    port: mode === "owned" ? runPort : port,
    host,
    warmup: null,
    sigtermSentAt: null,
    settledMs: null,
    exitMs: null,
    inFlight: { cohort: "in-flight-accepted", requested: n, acceptedBeforeSigterm: 0, statuses: {}, completed: 0, dropped: 0, pendingArrival: 0 },
    postSigterm: { cohort: "arrived-after-SIGTERM", probes: {}, refused: 0, accepted: 0, hung: 0 },
    drain: { clean: 0, timedOut: 0, prismaDisconnectFailed: 0, lines: [] },
    exit: { code: null, withinWindow: null },
    logSource: mode === "owned" ? "child stdout/stderr" : "app log file (offset tail)",
  };

  const target = mode === "owned" ? startOwned(runPort) : adoptTarget();
  let logOffset = 0;
  try {
    if (mode === "owned") {
      await waitFor(() => target.lines.some((l) => l.line.startsWith("sho ready")), 240_000, "sho ready");
    } else {
      logOffset = logSize(target.logFile);
      if (logOffset === null) throw new Error(`cannot stat the app log ${target.logFile}: drain lines unmeasurable`);
      const reachable = await httpGet("/api/health");
      if (reachable.status !== 200) throw new Error(`the adopted server is not answering (${reachable.status} ${reachable.error ?? ""})`);
    }

    const warm = await httpGet(httpPath);
    result.warmup = warm.status;
    result.warmupRelease = warm.body && typeof warm.body === "object" ? (warm.body.release ?? null) : null;
    if (warm.status !== 200) throw new Error(`warmup GET ${httpPath} returned ${warm.status}`);
    // The SHA gate runs here, before a single burst socket is opened (owned mode has no
    // listener before this point, so this is its first opportunity to see /api/health).
    shaGate(warm);

    // Cohort 1: N requests opened and written BEFORE the signal. Anything whose TCP
    // handshake had not completed by SIGTERM is not "in flight" and is called out
    // separately instead of being smeared into the burst count.
    const opened = await Promise.all(Array.from({ length: n }, () => connectOnce()));
    const accepted = opened.filter((o) => o.ok);
    for (const o of accepted) {
      o.socket.write(`GET ${httpPath} HTTP/1.1\r\nHost: ${host}:${result.port}\r\nConnection: close\r\n\r\n`);
    }
    const pending = accepted.map((o) => readToClose(o.socket));
    result.inFlight.acceptedBeforeSigterm = accepted.length;

    await sleep(preMs);
    const t0 = Date.now();
    result.sigtermSentAt = new Date(t0).toISOString();
    process.kill(target.pid, "SIGTERM");

    // Cohort 2: fresh SYNs AFTER the signal — classified on their own, never added to cohort 1.
    const probes = await Promise.all(
      probeOffsets.map(async (offset) => {
        await sleep(Math.max(0, offset - (Date.now() - t0)));
        return [offset, await probe(probeTimeoutMs)];
      }),
    );
    for (const [offset, verdict] of probes) result.postSigterm.probes[`+${offset}ms`] = verdict;

    const settled = await Promise.all(pending);
    result.settledMs = Date.now() - t0;
    result.inFlight.pendingArrival = n - accepted.length;
    for (const r of settled) {
      if (r.timedOut) result.inFlight.dropped += 1;
      else if (r.kind === "response") {
        const key = String(r.status);
        result.inFlight.statuses[key] = (result.inFlight.statuses[key] || 0) + 1;
      } else result.inFlight.dropped += 1;
    }
    result.inFlight.completed = settled.filter((r) => r.kind === "response").length;

    // Exit code: owned => the child's own status (no pid-1 guesswork, F9); adopt => a file.
    if (target.owned) {
      const ex = await Promise.race([
        target.exited,
        sleep(stopWindowMs).then(() => ({ code: null, signal: null, at: stamp(), timedOut: true })),
      ]);
      result.exit.code = ex.code;
      result.exit.signal = ex.signal ?? null;
      result.exitMs = ex.at;
      if (ex.timedOut) result.exit.note = "still running when the stop window closed";
    } else {
      await waitFor(() => !alive(target.pid), stopWindowMs, "the adopted pid to exit").catch(() => {});
      result.exitMs = Date.now() - t0;
      const codeFile = opts["exit-code-file"];
      if (codeFile) {
        const read = () => {
          try {
            const raw = fs.readFileSync(codeFile, "utf8").trim();
            return /^-?\d+$/.test(raw) ? Number(raw) : null;
          } catch {
            return null;
          }
        };
        await waitFor(() => read() !== null, 5_000, "the exit-code file").catch(() => {});
        result.exit.code = read();
        if (result.exit.code === null) result.exit.note = `no integer in ${codeFile}`;
      } else {
        result.exit.note = "no --exit-code-file: a pid-1 orphan has no observable exit status (F9)";
      }
    }
    result.exit.withinWindow =
      result.exitMs === null
        ? null
        : result.exitMs <= Math.max(drainWindowMs, stopWindowMs) && (result.exit.code === null || result.exit.code === 0);

    // The drain's own lines, from this run's window only.
    let rawLines = [];
    if (target.owned) rawLines = target.lines;
    else {
      const appended = readAppended(target.logFile, logOffset);
      if (appended === null) result.drain.unreadable = target.logFile;
      else rawLines = appended.split("\n").filter(Boolean).map((line) => ({ line: line.trim() }));
    }
    result.drain.lines = rawLines
      .filter((l) => /graceful shutdown:|prisma disconnect failed:|sho ready|unlistened/.test(l.line))
      .map((l) => l.line);
    result.drain.clean = result.drain.lines.filter((l) => l.includes(CLEAN_LOG)).length;
    result.drain.timedOut = result.drain.lines.filter((l) => l.includes(TIMEOUT_LOG)).length;
    result.drain.prismaDisconnectFailed = result.drain.lines.filter((l) => l.includes(DISCONNECT_FAILED)).length;

    // Teardown: after the process is gone the listener must be gone too — not "accepting".
    result.teardown = await probe(probeTimeoutMs);
  } finally {
    if (target.owned && target.child && alive(target.pid)) {
      try {
        target.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  // ---- legs, from the numbers above only
  const id = `n${n}`;
  const probeValues = Object.values(result.postSigterm.probes);
  result.postSigterm.refused = probeValues.filter((v) => v === "refused").length;
  result.postSigterm.accepted = probeValues.filter((v) => String(v).startsWith("accepted")).length;
  result.postSigterm.hung = probeValues.filter((v) => v === "hung").length;

  leg(`${id}.burst.accepted-before-sigterm`, result.inFlight.acceptedBeforeSigterm === n ? "PASS" : "FAIL",
    `${result.inFlight.acceptedBeforeSigterm}/${n} sockets completed the handshake and were written before SIGTERM`);
  leg(`${id}.burst.completed-200`,
    result.inFlight.completed === n && result.inFlight.dropped === 0 && Number(result.inFlight.statuses["200"] || 0) === n
      ? "PASS"
      : "FAIL",
    `${result.inFlight.completed}/${n} in-flight responses completed, statuses ${JSON.stringify(result.inFlight.statuses)}, dropped ${result.inFlight.dropped}, pending-arrival ${result.inFlight.pendingArrival}`);
  leg(`${id}.post-sigterm.refused`, result.postSigterm.refused === probeOffsets.length ? "PASS" : "FAIL",
    `probes ${JSON.stringify(result.postSigterm.probes)} — refused ${result.postSigterm.refused}/${probeOffsets.length}, accepted ${result.postSigterm.accepted}, hung ${result.postSigterm.hung}`);
  leg(`${id}.drain.clean-line`,
    result.drain.unreadable ? "NOT-MEASURED" : result.drain.clean >= 1 && result.drain.timedOut === 0 ? "PASS" : "FAIL",
    result.drain.unreadable
      ? `the app log ${result.drain.unreadable} could not be read: the drain line was NOT measured`
      : `clean ${result.drain.clean}, timed out ${result.drain.timedOut}, prisma-disconnect-failed ${result.drain.prismaDisconnectFailed}`,
    result.drain.lines);
  leg(`${id}.exit.code`, result.exit.code === null ? "NOT-MEASURED" : result.exit.code === 0 ? "PASS" : "FAIL",
    result.exit.code === null
      ? result.exit.note || "exit code not observed"
      : `exit code ${result.exit.code}${result.exit.signal ? ` (signal ${result.exit.signal})` : ""}${result.exitMs !== null ? ` at +${result.exitMs}ms` : ""}`);
  leg(`${id}.exit.within-window`, result.exit.withinWindow === null ? "NOT-MEASURED" : result.exit.withinWindow ? "PASS" : "FAIL",
    `${result.exitMs === null ? "no exit observed" : `exited +${result.exitMs}ms`} against drain ${drainWindowMs}ms / stop ${stopWindowMs}ms`);
  leg(`${id}.listener.closed`, result.teardown === "refused" ? "PASS" : "FAIL", `a connect after the run returned \`${result.teardown}\``);
  return result;
}

// ---------------------------------------------------------------- disconnect leg (F7), separate

// Reuses W40's instrument instead of a log line: scripts/w40-shutdown-pg-probe.mjs starts the
// real entry behind scripts/w40-exit-hold.cjs, opens the Prisma pool through /api/health, maps the
// process's own TCP source ports to pg_stat_activity backends, SIGTERMs it and samples
// "is the process alive" + "how many of our backends remain" until the process is gone.
// A `prisma disconnect failed:` line in the drain log is NOT evidence either way here.
async function runDisconnectLeg(disconnectPortToUse) {
  if (disconnectMode === "skip") {
    leg("disconnect.pool-closed-while-alive", "NOT-MEASURED", "--disconnect skip: the pool-closure leg was not run");
    return null;
  }
  const probeScript = path.join(ROOT, "scripts/w40-shutdown-pg-probe.mjs");
  if (!fs.existsSync(probeScript)) {
    leg("disconnect.pool-closed-while-alive", "NOT-MEASURED", `${probeScript} is missing: nothing measured`);
    return null;
  }

  const child = spawn(process.execPath, [probeScript], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(disconnectPortToUse),
      SHO_BIND_HOST: host,
      W40_EXIT_HOLD_MS: String(holdMs),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const sink = (chunk) => {
    out += chunk.toString();
    if (opts.verbose === "true") process.stdout.write(chunk);
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve("timeout");
    }, 300_000);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  const summaryLine = out.split("\n").find((line) => line.startsWith("PROBE SUMMARY "));
  const verdictLine = out.split("\n").find((line) => line.startsWith("PROBE VERDICT "));
  let summary = null;
  try {
    summary = summaryLine ? JSON.parse(summaryLine.slice("PROBE SUMMARY ".length)) : null;
  } catch {
    summary = null;
  }
  const detail = verdictLine ? verdictLine.replace(/^PROBE VERDICT\s*/, "") : summaryLine ? "no verdict line" : "the probe produced no verdict";

  if (code === "timeout") {
    leg("disconnect.pool-closed-while-alive", "NOT-MEASURED", `the W40 probe did not finish inside 300s (${detail})`);
  } else if (summary && summary.verdictCode === 0) {
    leg("disconnect.pool-closed-while-alive", "PASS", `${detail}; probe exit ${code}`, summary);
  } else if (summary && summary.verdictCode === 2) {
    leg("disconnect.pool-closed-while-alive", "FAIL", `${detail}; probe exit ${code}`, summary);
  } else if (summary && summary.verdictCode === 3) {
    leg("disconnect.pool-closed-while-alive", "NOT-MEASURED", `${detail}; probe exit ${code}`, summary);
  } else {
    leg("disconnect.pool-closed-while-alive", "NOT-MEASURED", `the probe did not reach a verdict (exit ${code}): ${out.trim().split("\n").slice(-2).join(" | ")}`);
  }
  return summary;
}

// ---------------------------------------------------------------- SHA gate

class ShaMismatch extends Error {}

let shaObserved = null;
let shaChecked = false;

function releaseOf(health) {
  return health && health.body && typeof health.body === "object" ? (health.body.release ?? null) : null;
}

// Fails LOUDLY and before any burst: the acceptance is meaningless against a different build.
function shaGate(health) {
  if (shaChecked) return;
  const release = releaseOf(health);
  if (release === null || release === undefined || String(release).trim() === "" || String(release) === "null") {
    shaChecked = true;
    leg("sha.release-echoed", "NOT-MEASURED",
      `GET /api/health did not echo a release (got ${JSON.stringify(release)}): the SHA under test cannot be confirmed, so nothing below may be called PASS`);
    return;
  }
  shaChecked = true;
  shaObserved = String(release).trim();
  const expected = expectedSha.trim().toLowerCase();
  const observed = shaObserved.toLowerCase();
  const match =
    expected === observed || (Math.min(expected.length, observed.length) >= 7 && (observed.startsWith(expected) || expected.startsWith(observed)));
  leg("sha.release-echoed", match ? "PASS" : "FAIL", `deployed release ${shaObserved} vs SHA under test ${expectedSha}`);
  if (!match) throw new ShaMismatch(`SHA MISMATCH: /api/health reports release=${shaObserved}, this acceptance is for ${expectedSha}. Refusing to run: nothing was measured.`);
}

const writeOut = (file, text) => {
  try {
    fs.writeFileSync(file, text);
  } catch (err) {
    say(`warn: could not write ${file}: ${err.message}`);
  }
};

// ---------------------------------------------------------------- main

function emit(payload) {
  const block = ["W61-2689-ACCEPTANCE-BEGIN", JSON.stringify(payload, null, 2), "W61-2689-ACCEPTANCE-END"].join("\n");
  say(block);
  if (opts["json-out"]) writeOut(opts["json-out"], `${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  say(`W61 SHO-2689 complete acceptance · target ${baseUrl} · sha-under-test ${expectedSha || "<missing>"} · mode ${mode} · bursts ${bursts.join("/")}`);
  if (!expectedSha) {
    say("FATAL: --sha <sha> is required: an acceptance without the SHA under test cannot be checked against /api/health.");
    process.exit(3);
  }

  const runs = [];
  let fatal = null;
  try {
    if (mode === "adopt") {
      const pre = await httpGet("/api/health");
      leg("target.reachable", pre.status === 200 ? "PASS" : "NOT-MEASURED",
        pre.status === 200 ? `/api/health 200 in ${pre.ms}ms` : `no answer from ${baseUrl} (${pre.status} ${pre.error ?? ""})`);
      if (pre.status === 200) shaGate(pre);
    }
    for (const n of bursts) runs.push(await runOne(n));
    await runDisconnectLeg(disconnectPort || port + 1);
  } catch (err) {
    fatal = err;
  }

  const counts = { pass: 0, fail: 0, notMeasured: 0 };
  for (const l of legs) {
    if (l.status === "PASS") counts.pass += 1;
    else if (l.status === "FAIL") counts.fail += 1;
    else counts.notMeasured += 1;
  }
  const verdict = counts.fail > 0 ? "FAIL" : counts.notMeasured > 0 ? "INCOMPLETE" : "PASS";
  const finalExit = fatal instanceof ShaMismatch ? 4 : fatal ? 3 : verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2;

  const payload = {
    tool: "w61-2689-accept",
    version: 1,
    generatedAt: new Date().toISOString(),
    host: `${host === "127.0.0.1" ? "local" : host}`,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    mode,
    target: baseUrl,
    shaUnderTest: expectedSha,
    shaObserved,
    bursts,
    drainWindowMs,
    stopWindowMs,
    probeOffsets,
    runs,
    legs,
    counts,
    verdict,
    exitCode: finalExit,
    ...(fatal ? { fatal: fatal.message } : {}),
  };

  say("");
  for (const l of legs) say(`LEG ${l.status.padEnd(12)} ${l.id} — ${l.detail}`);
  say("");
  say(`SUMMARY passed=${counts.pass} failed=${counts.fail} not-measured=${counts.notMeasured} verdict=${verdict}`);
  emit(payload);
  process.exit(finalExit);
}

main().catch((err) => {
  say(`FATAL harness error: ${err && err.stack ? err.stack : err}`);
  emit({ tool: "w61-2689-accept", version: 1, generatedAt: new Date().toISOString(), mode, target: baseUrl, shaUnderTest: expectedSha, legs, verdict: "FAIL", exitCode: 3, fatal: String(err) });
  process.exit(3);
});

