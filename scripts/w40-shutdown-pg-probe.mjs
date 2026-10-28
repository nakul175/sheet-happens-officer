// SHO-2689 F7 — INDEPENDENT SECOND METHOD (W40). Re-runnable, read-only observation.
//
// Question: after a clean SIGTERM drain of the real server entry (server.js), are the
// process's PostgreSQL connections actually GONE — did db.$disconnect() close them while
// the process was still alive — or do they only disappear because the process exits?
//
// Method: this script starts the real server (no test spy, no injected `disconnect`).
// The app's connections are identified in pg_stat_activity by the server process's own
// TCP source ports (lsof) -> backend pids. Because shutdown.ts:435 exits ~1ms after the
// disconnect returns, the process is held open (scripts/w40-exit-hold.cjs) exactly in the
// window between "$disconnect() returned" and "the process is gone", and pg_stat_activity
// is sampled continuously in that window.
//
// Usage, from the repo root (no secret is printed):
//   DATABASE_URL='postgresql://...?schema=w40' PORT=3182 node scripts/w40-shutdown-pg-probe.mjs
// Exit: 0 = (a) closed while alive; 2 = (b) still open at the last alive sample;
//       3 = (c) cannot distinguish.  1 = probe error.

import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = Number(process.env.PORT || 3182);
const HOLD_MS = Number(process.env.W40_EXIT_HOLD_MS || 5000);
// Control run: W40_SIGNAL=KILL has no drain at all — the pool can then only die with
// the process. Contrast that with SIGTERM in the same fixture.
const SIGNAL = (process.env.W40_SIGNAL || "SIGTERM").toUpperCase().startsWith("SIG")
  ? (process.env.W40_SIGNAL || "SIGTERM").toUpperCase()
  : `SIG${(process.env.W40_SIGNAL || "TERM").toUpperCase()}`;

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  console.error("probe: DATABASE_URL is required (never printed)");
  process.exit(1);
}
// node-postgres does not need the ?schema=... param the app uses.
const url = new URL(rawUrl);
const connectionString = `postgresql://${url.username}:${url.password}@${url.host}${url.pathname}`;

const client = new pg.Client({ connectionString });
const say = (line) => process.stdout.write(`${line}\n`);
const t0 = Date.now();
const stamp = () => Date.now() - t0;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function serverPorts(pid) {
  let out = "";
  try {
    out = execFileSync("lsof", ["-nP", "-p", String(pid), "-iTCP", "-a", "-i"], { encoding: "utf8" });
  } catch {
    return [];
  }
  const ports = new Set();
  for (const line of out.split("\n")) {
    const m = /\sTCP\s+(\S+)->(\S+):55432\s+\(ESTABLISHED\)/.exec(line);
    if (m) {
      const local = m[1];
      const p = Number(local.slice(local.lastIndexOf(":") + 1));
      if (Number.isInteger(p)) ports.add(p);
    }
  }
  return [...ports];
}

async function snapshot(ports, pids) {
  const res = await client.query(
    `select pid, client_port, state, backend_start
       from pg_stat_activity
      where datname = current_database()
        and (client_port = any($1::int[]) or pid = any($2::int[]))
      order by pid`,
    [ports, pids],
  );
  return res.rows;
}

const child = spawn(
  process.execPath,
  ["--require", path.join(ROOT, "scripts/w40-exit-hold.cjs"), "server.js"],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(PORT),
      SHO_BIND_HOST: "127.0.0.1",
      W40_EXIT_HOLD_MS: String(HOLD_MS),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const events = [];
const onLine = (side) => (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (!line.trim()) continue;
    events.push({ at: stamp(), side, line: line.trim() });
    say(`[${String(stamp()).padStart(6)}ms ${side}] ${line.trim()}`);
  }
};
child.stdout.on("data", onLine("out"));
child.stderr.on("data", onLine("err"));

const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, at: stamp() })));

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

try {
  await client.connect();
  await waitFor(() => events.some((e) => e.line.startsWith("sho ready")), 240_000, "sho ready");
  say(`PROBE serving at +${stamp()}ms (pid=${child.pid}, port=${PORT})`);

  // Warm up with real HTTP requests through the route that touches the DB.
  await Promise.all(
    Array.from({ length: 4 }, () => fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.text()).catch(() => "")),
  );

  const ports = serverPorts(child.pid);
  say(`PROBE server tcp->55432 client ports: [${ports.join(",")}]`);
  const before = await snapshot(ports, []);
  const backendPids = before.map((r) => r.pid);
  say(`PROBE before SIGTERM: ${before.length} app backend(s) ${JSON.stringify(before)}`);
  if (before.length === 0) throw new Error("the server opened no PostgreSQL connection: nothing to measure");

  process.kill(child.pid, SIGNAL);
  say(`PROBE ${SIGNAL} -> ${child.pid} at +${stamp()}ms`);

  // Sample continuously: is the process alive, and how many of OUR backends does
  // pg_stat_activity still show? Aliveness is taken on both sides of the query so a
  // sample is only counted as "while alive" when the process survived it.
  const samples = [];
  for (;;) {
    const aliveBefore = alive(child.pid);
    const at = stamp();
    let rows = null;
    try {
      rows = await snapshot(ports, backendPids);
    } catch {
      rows = null;
    }
    const isAlive = aliveBefore && alive(child.pid);
    samples.push({
      at,
      alive: isAlive,
      rows: rows === null ? null : rows.length,
      states: rows === null ? null : rows.map((r) => r.state),
      drainLogged: events.some((e) => e.line.includes("graceful shutdown:")),
      exitRequested: events.some((e) => e.line.startsWith("w40-exit-requested")),
    });
    if (!isAlive) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  const result = await exited;
  say(`PROBE process gone at +${result.at}ms code=${result.code} signal=${result.signal}`);

  const afterExit = await snapshot(ports, backendPids);
  say(`PROBE after exit: ${afterExit.length} app backend(s) still in pg_stat_activity`);

  const drainLine = events.filter((e) => e.line.includes("graceful shutdown:")).map((e) => e.line);
  const aliveSamples = samples.filter((s) => s.alive);
  const lastAlive = aliveSamples[aliveSamples.length - 1];
  const firstZeroWhileAlive = aliveSamples.find((s) => s.rows === 0);
  const lastNonZeroWhileAlive = [...aliveSamples].reverse().find((s) => s.rows !== 0);

  say("");
  say(`PROBE drain log: ${JSON.stringify(drainLine)}`);
  say(`PROBE alive samples: ${aliveSamples.length}, last alive sample: ${JSON.stringify(lastAlive)}`);
  say(`PROBE last alive sample with connections still open: ${JSON.stringify(lastNonZeroWhileAlive ?? null)}`);
  say(`PROBE first alive sample with 0 connections: ${JSON.stringify(firstZeroWhileAlive ?? null)}`);

  let verdict;
  let code = 3;
  if (firstZeroWhileAlive && (!lastNonZeroWhileAlive || firstZeroWhileAlive.at >= lastNonZeroWhileAlive.at)) {
    verdict = `(a) $disconnect() closed every app connection while the process was still alive: 0 backends from +${firstZeroWhileAlive.at}ms, process exited at +${result.at}ms`;
    code = 0;
  } else if (lastNonZeroWhileAlive) {
    verdict = `(b) connections were still open at the last moment the process was alive (+${lastNonZeroWhileAlive.at}ms, ${lastNonZeroWhileAlive.rows} backend(s)); they vanished only when the process died at +${result.at}ms`;
    code = 2;
  } else {
    verdict = "(c) cannot distinguish: no sample landed in the window between the drain and the process exit";
  }
  say(`PROBE VERDICT ${SIGNAL === "SIGTERM" ? "" : `[control ${SIGNAL}] `}${verdict}`);
  say(
    `PROBE SUMMARY ${JSON.stringify({ signal: SIGNAL, verdictCode: code, exitCode: result.code, drainLine, backendPids, samples: samples.length })}`,
  );
  process.exitCode = code;
} catch (err) {
  console.error(`probe: ${err.message}`);
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
