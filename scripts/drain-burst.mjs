// SHO-2689 local drain probe. Same protocol as the staging burst and tests/shutdown-next.test.ts:
// connect N sockets, write the request, SIGTERM 40ms later, then probe a NEW connection at
// +16ms and +143ms. Reuses tests/shutdown-next.test.ts's readResponse/probe semantics; it does
// not spawn taskset (Linux-only) and it runs server.js in dev mode because this worktree has no
// production `.next` build and building would rewrite the dev server's directory.
import net from "node:net";
import { spawn } from "node:child_process";

const N = Number(process.argv[2] ?? "40");
const PORT_ARG = Number(process.argv[3] ?? "0");
const URL_PATH = "/api/health";

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
      resolve({ status: Number.isFinite(status) ? status : 0, bytes: buf.length, reset });
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
const warm = await fetch(`http://127.0.0.1:${port}${URL_PATH}`, { redirect: "manual" }).catch((e) => ({ status: 0, text: async () => String(e) }));
await warm.text();
marks.push({ warmup: warm.status });
if (warm.status !== 200) throw new Error(`warm-up ${URL_PATH} was ${warm.status}`);

const sockets = await Promise.all(Array.from({ length: N }, () => openSocket()));
const pending = Promise.all(sockets.map((s) => readResponse(s)));
for (const socket of sockets) {
  socket.write(`GET ${URL_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
}
await new Promise((r) => setTimeout(r, 40));
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
const summary = {
  n: N,
  inFlight: { requested: N, non200: settled.filter((r) => r.status !== 200 || r.reset).length, statuses },
  acceptedBeforeSigterm: { all200: settled.every((r) => r.status === 200 && !r.reset) },
  afterSigterm: { late16, late143 },
  exit: result,
  shutdownLines: lines,
  drainedLine: drainedAt,
  elapsedMs: lastDone - t0,
  serverStdoutTail: stdout.split("\n").filter(Boolean).slice(-4),
  serverStderrTail: stderr.split("\n").filter(Boolean).slice(-4),
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (child.exitCode === null) child.kill("SIGKILL");
process.exit(0);
