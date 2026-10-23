// SHO-2689 local drain probe. Same protocol as the staging burst and tests/shutdown-next.test.ts:
// connect N sockets, write the request, SIGTERM 40ms later, then probe a NEW connection at
// +16ms and +143ms. Reuses tests/shutdown-next.test.ts's readResponse/probe semantics; it does
// not spawn taskset (Linux-only) and it runs server.js in dev mode because this worktree has no
// production `.next` build and building would rewrite the dev server's directory.
import net from "node:net";
import { spawn } from "node:child_process";

const N = Number(process.argv[2] ?? "40");
const flags = process.argv.slice(3);
// W83 / SHO-2760: `--slow` reproduces the burst block's own request — the route that
// holds a request open across SIGTERM — instead of /api/health, which answers in ~1 ms
// and is therefore already served when SIGTERM lands. Without it this probe only measured
// "a burst of fast requests" and could never see an accepted-but-unserved request.
// W85 / SHO-2689: with /api/health nothing is queued at SIGTERM, so a 0-drop rate run bounds
// the accept-loop speed and says nothing about the queue. Both modes stay, because they answer
// different questions and reporting one as the other is how a vacuous green gets made.
const SLOW = flags.includes("--slow");
const ASSERT = flags.includes("--assert");
const PORT_ARG = Number(flags.find((arg) => /^\d+$/.test(arg)) ?? "0");
const URL_PATH = SLOW ? "/api/shutdown-slow?ms=2000" : "/api/health";
const WARM_PATH = SLOW ? "/api/shutdown-slow?ms=0" : "/api/health";
// W85: 40ms is the staging protocol. Left configurable so a rate run can shorten the window and
// prove whether a drop needs a socket still in the kernel accept queue at SIGTERM.
const SIGTERM_DELAY_MS = Number(process.env.BURST_SIGTERM_DELAY_MS ?? "40");
if (!Number.isInteger(N) || N < 1) throw new Error(`N must be a positive integer, got ${process.argv[2]}`);
// `--assert` asserts the burst-tier legs, one of which is "N requests were still unserved at SIGTERM".
// At /api/health every request is already answered when the signal lands, so that assertion would fail
// for the probe's own vacuity rather than for the code. Say so instead of emitting a misleading FAIL.
if (ASSERT && !SLOW) {
  throw new Error("--assert needs --slow: it asserts that N requests were still open at SIGTERM, which /api/health can never produce");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const port = PORT_ARG || (await freePort());
const child = spawn(process.execPath, ["--import", "tsx", "server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(port),
    SHO_BIND_HOST: "127.0.0.1",
    ...(SLOW ? { SHUTDOWN_TEST_SLOW_MS: "1", SHUTDOWN_DRAIN_MS: "15000" } : {}),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
const marks = [];
child.stdout.on("data", (c) => {
  stdout += c.toString();
});
child.stderr.on("data", (c) => {
  stderr += c.toString();
});
const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));

async function waitFor(re, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (re.test(stdout)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${re}\nstdout:\n${stdout.slice(-1500)}\nstderr:\n${stderr.slice(-1500)}`);
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const fail = (err) => {
      socket.off("connect", ok);
      reject(err);
    };
    const ok = () => {
      socket.off("error", fail);
      socket.on("error", () => {});
      resolve(socket);
    };
    socket.once("error", fail);
    socket.once("connect", ok);
  });
}

function readResponse(socket) {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const done = (reset) => {
      if (settled) return;
      settled = true;
      const head = buf.split("\r\n\r\n")[0] ?? "";
      const status = Number(head.split(" ")[1]);
      resolve({ status: Number.isFinite(status) ? status : 0, bytes: buf.length, reset, body: buf });
    };
    const timer = setTimeout(() => done(true), 25000);
    socket.on("data", (c) => (buf += c.toString()));
    socket.on("error", () => {
      clearTimeout(timer);
      done(true);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      done(!buf.includes("HTTP/"));
    });
  });
}

function probe() {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("hung");
    }, 300);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("open");
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      resolve(err.code === "ECONNREFUSED" ? "refused" : err.code ?? "error");
    });
  });
}

const probeAt = (t0, at) => new Promise((r) => setTimeout(() => r(probe()), Math.max(0, t0 + at - Date.now())));

await waitFor(/sho ready (\d+)/, 180000);
const countHits = () => stdout.split("sho-hit\n").length - 1;
const warm = await fetch(`http://127.0.0.1:${port}${WARM_PATH}`, { redirect: "manual" }).catch((e) => ({ status: 0, text: async () => String(e) }));
const warmBody = await warm.text();
marks.push({ warmup: warm.status });
if (warm.status !== 200) throw new Error(`warm-up ${WARM_PATH} was ${warm.status}: ${warmBody.slice(0, 300)}`);
const hitsBefore = countHits();

const sockets = await Promise.all(Array.from({ length: N }, () => openSocket()));
// W83: track which of the N have already been answered, so the JSON can state how many were
// genuinely in flight when SIGTERM landed. W49's run hit /api/health (~1 ms), so its sockets
// were all served before the signal and the drain assertion was vacuous.
const done = new Array(N).fill(false);
const pending = Promise.all(
  sockets.map((s, i) =>
    readResponse(s).then((r) => {
      done[i] = true;
      return r;
    }),
  ),
);
for (const socket of sockets) {
  socket.write(`GET ${URL_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
}
await new Promise((r) => setTimeout(r, SIGTERM_DELAY_MS));
// W83: how many were still unserved when the signal landed. Without it, "accepted before
// SIGTERM" is an assumption: at /api/health every socket is already answered and the
// assertion is vacuous, which is exactly how the 0-drop rate run reads as a pass.
const stillOpenAtSigterm = done.filter((flag) => !flag).length;
const t0 = Date.now();
child.kill("SIGTERM");
const [late16, late143] = await Promise.all([probeAt(t0, 16), probeAt(t0, 143)]);
const settled = await pending;
const lastDone = Date.now();
const result = await exited;
const drainedAt = stdout.includes("graceful shutdown: drained in-flight requests") ? "logged" : "absent";
const lines = stdout.split("\n").filter((l) => l.startsWith("graceful shutdown:"));

const statuses = settled.reduce((acc, r) => {
  const key = r.reset ? "reset" : String(r.status);
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});
const hits = countHits() - hitsBefore;
const bodyDone = settled.filter((r) => r.body.includes("done")).length;
const non200 = settled.filter((r) => r.status !== 200 || r.reset).length;
const summary = {
  n: N,
  sigtermDelayMs: SIGTERM_DELAY_MS,
  mode: SLOW ? "slow" : "health",
  path: URL_PATH,
  stillOpenAtSigterm,
  hits,
  hitsIncludingWarmup: hits + 1,
  inFlight: { requested: N, non200, bodyDone, statuses },
  // W49's classification needs the connection, not just the count: index is the write order, so a
  // non-200 here names the socket that was accepted before SIGTERM and did not get its 200.
  connections: settled.map((r, index) => ({ index, status: r.status, reset: r.reset, bytes: r.bytes })),
  acceptedBeforeSigterm: { all200: non200 === 0 },
  afterSigterm: { late16, late143 },
  exit: result,
  shutdownLines: lines,
  drainedLine: drainedAt,
  elapsedMs: lastDone - t0,
  serverStdoutTail: stdout.split("\n").filter(Boolean).slice(-4),
  serverStderrTail: stderr.split("\n").filter(Boolean).slice(-4),
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

if (ASSERT) {
  // tests/shutdown-next.test.ts:231-243, minus the two assertions src/lib/shutdown.ts:205-208
  // and :246-249 make Linux-only: exit code 0 and the drained line. Asserting those here would
  // fail for the host, not for the code, and would turn a platform fact into a false red.
  const reasons = [];
  if (stillOpenAtSigterm !== N) reasons.push(`stillOpenAtSigterm ${stillOpenAtSigterm} != n ${N}`);
  if (hits !== N) reasons.push(`hits ${hits} != n ${N}`);
  if (bodyDone !== N) reasons.push(`bodyDone ${bodyDone} != n ${N}`);
  if (non200 !== 0) reasons.push(`statuses ${JSON.stringify(statuses)}`);
  if (late16 !== "refused" || late143 !== "refused") reasons.push(`probes ${late16}/${late143} != refused/refused`);
  process.stdout.write(
    `drain-burst N=${N} mode=${summary.mode}: ${reasons.length === 0 ? "PASS" : "FAIL"} stillOpenAtSigterm=${stillOpenAtSigterm} hits=${hits} statuses=${JSON.stringify(statuses)} exit=${result.code} late16=${late16} late143=${late143}${reasons.length ? ` -- ${reasons.join("; ")}` : ""}\n`,
  );
  if (reasons.length !== 0) {
    if (child.exitCode === null) child.kill("SIGKILL");
    process.exit(1);
  }
}
if (child.exitCode === null) child.kill("SIGKILL");
process.exit(0);
