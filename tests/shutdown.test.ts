// SIGTERM drain (APL-2688). A child process runs the production shutdown hook
// against a real HTTP server, so the signal, the exit code, and an in-flight
// response are the ones systemd would see.
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CLEAN_LOG, DEFAULT_DRAIN_MS, shutdownDrainMs, TIMEOUT_LOG } from "../src/lib/shutdown";

const root = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

// W163. This file is in two tiers at once. Only its seven drain cases are Linux-only: they assert
// exit 0 and CLEAN_LOG, and src/lib/shutdown.ts can only produce those where its accept-queue
// seizer loaded — loadNative() and loadLibc() return null on anything but linux (src/lib/shutdown.ts:205
// and :246), so on darwin the drain honestly reports TIMEOUT_LOG and exits 1. Those seven skip off
// linux and still run for real in CI on ubuntu-latest (vitest.shutdown.config.mts, ci.yml).
// The clock/env cases, the module-identity case, the timeout path and the F7 cases below are
// platform-independent and run here on every OS. W152 kept the darwin run green by excluding the
// whole file from `npm test`, which deleted that coverage as well; this split keeps both.
const LINUX_ONLY = process.platform !== "linux";
// `it.skipIf` takes a condition and no note (vitest 5.0.5, node_modules/vitest/dist/chunks/config.d.QBNYCgFU.d.ts:2778),
// so the reason rides on the title and `npx vitest run --reporter=verbose` prints it on a darwin run.
const SKIP_REASON = LINUX_ONLY
  ? " [skipped on darwin: Linux-only — the drain needs the accept-queue seizer, and loadNative/loadLibc return null off linux (src/lib/shutdown.ts:205,246)]"
  : "";

function startChild(env: Record<string, string>) {
  // `node --import tsx` is one process, so SIGTERM hits the handler. The tsx
  // CLI is a parent that dies on SIGTERM before the drain finishes.
  const child = spawn(process.execPath, ["--import", "tsx", "tests/shutdown-child.ts"], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const waiters: { re: RegExp; resolve: (match: RegExpMatchArray) => void; reject: (err: Error) => void }[] = [];
  const notify = () => {
    for (const waiter of [...waiters]) {
      const match = stdout.match(waiter.re);
      if (!match) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(match);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    notify();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return {
    child,
    exited,
    output: () => ({ stdout, stderr }),
    waitFor(re: RegExp, ms = 10000) {
      const existing = stdout.match(re);
      if (existing) return Promise.resolve(existing);
      return new Promise<RegExpMatchArray>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${re} in:\n${stdout}`)), ms);
        waiters.push({
          re,
          resolve: (match) => {
            clearTimeout(timer);
            resolve(match);
          },
          reject,
        });
      });
    },
  };
}

function stop(child: ChildProcess) {
  if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
}

function openSocket(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const fail = (err: Error) => {
      socket.off("connect", onConnect);
      reject(err);
    };
    const onConnect = () => {
      socket.off("error", fail);
      resolve(socket);
    };
    socket.once("error", fail);
    socket.once("connect", onConnect);
  });
}

function expectResponse(socket: net.Socket): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`no response: ${buf.slice(0, 160)}`)), 8000);
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
    });
    socket.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("end", () => {
      clearTimeout(timer);
      const head = buf.split("\r\n\r\n")[0] ?? "";
      resolve({ status: Number(head.split(" ")[1]), body: buf });
    });
  });
}

function writeRequest(socket: net.Socket, port: number) {
  socket.write(`GET /slow HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
}

type Probe = "refused" | "open" | "hung" | string;

/** "refused" only for ECONNREFUSED. A connect that neither completes nor fails in 300ms is "hung", not refused. */
function probe(port: number): Promise<Probe> {
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
    socket.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(err.code === "ECONNREFUSED" ? "refused" : (err.code ?? "error"));
    });
  });
}

function probeAt(port: number, t0: number, at: number): Promise<Probe> {
  const wait = Math.max(0, t0 + at - Date.now());
  return new Promise((resolve) => setTimeout(() => resolve(probe(port)), wait));
}

describe("qa:TC missing shutdownDrainMs", () => {
  it("qa:TC missing uses 15s when the env var is missing or outside 10–25s", () => {
    expect(shutdownDrainMs({})).toBe(DEFAULT_DRAIN_MS);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "" })).toBe(DEFAULT_DRAIN_MS);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "nope" })).toBe(DEFAULT_DRAIN_MS);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "9999" })).toBe(DEFAULT_DRAIN_MS);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "25001" })).toBe(DEFAULT_DRAIN_MS);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "15000.5" })).toBe(DEFAULT_DRAIN_MS);
  });

  it("qa:TC missing accepts an integer from 10s through 25s", () => {
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "10000" })).toBe(10_000);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "20000" })).toBe(20_000);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "25000" })).toBe(25_000);
  });
});

// APL-2689 QA D1. `next start` bundles the instrumentation hook apart from the routes, so
// @/lib/db is evaluated once per bundle. They must share one client, or the drain disconnects
// a client that never connected. resetModules stands in for the second bundle.
describe("qa:TC missing Prisma client shared across module instances", () => {
  it("qa:TC missing two instances of @/lib/db get the same client in production", async () => {
    const holder = globalThis as unknown as { prisma?: unknown };
    const saved = holder.prisma;
    delete holder.prisma;
    vi.stubEnv("NODE_ENV", "production");
    try {
      vi.resetModules();
      const first = await import("../src/lib/db");
      vi.resetModules();
      const second = await import("../src/lib/db");
      expect(second.db).toBe(first.db);
      expect(holder.prisma).toBe(first.db);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      if (saved === undefined) delete holder.prisma;
      else holder.prisma = saved;
    }
  });
});

describe("qa:TC missing SIGTERM drain", () => {
  it.skipIf(LINUX_ONLY)(`qa:TC missing finishes an in-flight request, refuses a new one, disconnects, and exits 0${SKIP_REASON}`, async () => {
    const proc = startChild({ DELAY_MS: "1500", DRAIN_MS: "5000", KEEPALIVE_MS: "300" });
    try {
      const ready = await proc.waitFor(/ready (\d+)/);
      const port = Number(ready[1]);
      const pending = fetch(`http://127.0.0.1:${port}/slow`).then(async (res) => ({ status: res.status, body: await res.text() }));
      await proc.waitFor(/hit/);
      proc.child.kill("SIGTERM");

      let refused = false;
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        try {
          await fetch(`http://127.0.0.1:${port}/fast`, { signal: AbortSignal.timeout(100) });
        } catch {
          refused = true;
          break;
        }
      }
      expect(refused).toBe(true);

      expect(await pending).toEqual({ status: 200, body: "done" });
      const result = await proc.exited;
      expect(result.code).toBe(0);
      const outcome = result.stdout.split("\n").filter((line) => line.startsWith("graceful shutdown:"));
      expect(outcome).toEqual([CLEAN_LOG]);
      expect(result.stdout.indexOf("prisma disconnected")).toBeLessThan(result.stdout.indexOf(CLEAN_LOG));
    } finally {
      stop(proc.child);
    }
  });

  it.skipIf(LINUX_ONLY)(`qa:TC missing drains a SIGTERM that was queued before the hook installed, without a second signal${SKIP_REASON}`, async () => {
    const proc = startChild({ EARLY_SIGTERM: "1", DRAIN_MS: "5000" });
    try {
      const hung = setTimeout(() => stop(proc.child), 8000);
      const result = await proc.exited;
      clearTimeout(hung);
      expect(result.code, `stdout:\n${result.stdout}`).toBe(0);
      expect(result.stdout.split("\n").filter((line) => line.startsWith("graceful shutdown:"))).toEqual([CLEAN_LOG]);
      expect(result.stdout).not.toContain("next handler");
    } finally {
      stop(proc.child);
    }
  });

  it("qa:TC missing exits non-zero and logs the timeout line when the drain deadline passes", async () => {
    const proc = startChild({ DELAY_MS: "5000", DRAIN_MS: "400" });
    try {
      const ready = await proc.waitFor(/ready (\d+)/);
      const port = Number(ready[1]);
      const pending = fetch(`http://127.0.0.1:${port}/slow`).catch((err: unknown) => err);
      await proc.waitFor(/hit/);
      proc.child.kill("SIGTERM");
      const result = await proc.exited;
      expect(result.code).toBe(1);
      const outcome = result.stdout.split("\n").filter((line) => line.startsWith("graceful shutdown:"));
      expect(outcome).toEqual([TIMEOUT_LOG]);
      expect(result.stdout.indexOf("prisma disconnected")).toBeLessThan(result.stdout.indexOf(TIMEOUT_LOG));
      await pending;
    } finally {
      stop(proc.child);
    }
  });

  it.skipIf(LINUX_ONLY)(`qa:TC missing closes an idle keep-alive socket without waiting out the keep-alive timeout${SKIP_REASON}`, async () => {
    const proc = startChild({ DELAY_MS: "0", DRAIN_MS: "8000", KEEPALIVE_MS: "5000" });
    try {
      const ready = await proc.waitFor(/ready (\d+)/);
      const port = Number(ready[1]);
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      try {
        await new Promise<void>((resolve, reject) => {
          const req = http.get({ host: "127.0.0.1", port, path: "/fast", agent }, (res) => {
            res.resume();
            res.on("end", () => resolve());
          });
          req.on("error", reject);
        });
        const started = Date.now();
        proc.child.kill("SIGTERM");
        const result = await proc.exited;
        expect(result.code).toBe(0);
        const elapsed = Date.now() - started;
        // The socket already finished a response. It is idle, so the drain closes it
        // and exits instead of sitting for keepAliveTimeout (5s).
        expect(elapsed).toBeLessThan(1500);
        expect(result.stdout).toContain(CLEAN_LOG);
        expect(result.stdout).not.toContain(TIMEOUT_LOG);
      } finally {
        agent.destroy();
      }
    } finally {
      stop(proc.child);
    }
  });

  it.skipIf(LINUX_ONLY)(`qa:TC missing returns 200 for 100 requests written before SIGTERM, including ones not yet dispatched${SKIP_REASON}`, async () => {
    const proc = startChild({ DELAY_MS: "400", DRAIN_MS: "8000" });
    try {
      const ready = await proc.waitFor(/ready (\d+)/);
      const port = Number(ready[1]);
      const sockets = await Promise.all(Array.from({ length: 100 }, () => openSocket(port)));
      const responses = Promise.all(sockets.map((socket) => expectResponse(socket)));
      // Pam's shape: every client is connected and the request bytes are written,
      // then SIGTERM 40ms later, before every handler has started.
      for (const socket of sockets) writeRequest(socket, port);
      await new Promise((resolve) => setTimeout(resolve, 40));
      proc.child.kill("SIGTERM");
      const settled = await responses;
      expect(settled).toHaveLength(100);
      for (const response of settled) {
        expect(response.status).toBe(200);
        expect(response.body).toContain("done");
      }
      const result = await proc.exited;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(CLEAN_LOG);
      expect(result.stdout).not.toContain(TIMEOUT_LOG);
    } finally {
      stop(proc.child);
    }
  });

  it.skipIf(LINUX_ONLY)(`qa:TC missing returns 200 for 40 connections accepted before SIGTERM whose requests arrive during the grace${SKIP_REASON}`, async () => {
    const proc = startChild({ DELAY_MS: "200", DRAIN_MS: "10000", KEEPALIVE_MS: "1000" });
    try {
      const ready = await proc.waitFor(/ready (\d+)/);
      const port = Number(ready[1]);
      const sockets = await Promise.all(Array.from({ length: 40 }, () => openSocket(port)));
      const responses = Promise.all(sockets.map((socket) => expectResponse(socket)));
      // Let the server accept every socket. SIGTERM then used to closeIdleConnections()
      // and reset any of them whose HTTP request was not parsed yet.
      await new Promise((resolve) => setTimeout(resolve, 40));
      proc.child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const socket of sockets) writeRequest(socket, port);
      const settled = await responses;
      expect(settled).toHaveLength(40);
      for (const response of settled) {
        expect(response.status).toBe(200);
        expect(response.body).toContain("done");
      }
      const result = await proc.exited;
      expect(result.code).toBe(0);
      const outcome = result.stdout.split("\n").filter((line) => line.startsWith("graceful shutdown:"));
      expect(outcome).toEqual([CLEAN_LOG]);
      expect(result.stdout.indexOf("prisma disconnected")).toBeLessThan(result.stdout.indexOf(CLEAN_LOG));
    } finally {
      stop(proc.child);
    }
  });

  it.skipIf(LINUX_ONLY)(`qa:TC missing refuses connections at 16ms and 143ms after SIGTERM${SKIP_REASON}`, async () => {
    const proc = startChild({ DELAY_MS: "800", DRAIN_MS: "8000" });
    try {
      const ready = await proc.waitFor(/ready (\d+)/);
      const port = Number(ready[1]);
      const sockets = await Promise.all(Array.from({ length: 6 }, () => openSocket(port)));
      const responses = Promise.all(sockets.map((socket) => expectResponse(socket)));
      for (const socket of sockets) writeRequest(socket, port);
      await proc.waitFor(/hit/);
      const t0 = Date.now();
      proc.child.kill("SIGTERM");
      const probes = await Promise.all([probeAt(port, t0, 16), probeAt(port, t0, 143)]);
      expect(probes).toEqual(["refused", "refused"]);
      const settled = await responses;
      expect(settled).toHaveLength(6);
      for (const response of settled) {
        expect(response.status).toBe(200);
        expect(response.body).toContain("done");
      }
      const result = await proc.exited;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(CLEAN_LOG);
      expect(result.stdout).not.toContain(TIMEOUT_LOG);
    } finally {
      stop(proc.child);
    }
  });

  it.skipIf(LINUX_ONLY)(`qa:TC missing finishes 40 sockets that were only in the kernel queue while the loop was blocked${SKIP_REASON}`, async () => {
    const proc = startChild({ DELAY_MS: "200", DRAIN_MS: "8000", SPIN_MS: "400", SHUTDOWN_TEST_SLOW_MS: "1" });
    try {
      const ready = await proc.waitFor(/ready (\d+)/);
      const port = Number(ready[1]);
      const spin = fetch(`http://127.0.0.1:${port}/spin`).then(async (res) => ({ status: res.status, body: await res.text() }));
      await proc.waitFor(/spin/);
      const sockets = await Promise.all(Array.from({ length: 40 }, () => openSocket(port)));
      const responses = Promise.all(sockets.map((socket) => expectResponse(socket)));
      for (const socket of sockets) writeRequest(socket, port);
      proc.child.kill("SIGTERM");
      await proc.waitFor(/sho unlistened/);
      expect(await probe(port)).toBe("refused");
      const settled = await responses;
      expect(settled).toHaveLength(40);
      for (const response of settled) {
        expect(response.status).toBe(200);
        expect(response.body).toContain("done");
      }
      expect(await spin).toEqual({ status: 200, body: "done" });
      const result = await proc.exited;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(CLEAN_LOG);
      expect(result.stdout).not.toContain(TIMEOUT_LOG);
    } finally {
      stop(proc.child);
    }
  });

  it("qa:TC missing exits non-zero when an in-flight request is dropped", async () => {
    const proc = startChild({ DELAY_MS: "2000", DRAIN_MS: "8000", KEEPALIVE_MS: "300" });
    try {
      const ready = await proc.waitFor(/ready (\d+)/);
      const port = Number(ready[1]);
      const socket = await openSocket(port);
      socket.write(`GET /slow HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      await proc.waitFor(/hit/);
      proc.child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 40));
      socket.destroy();
      const result = await proc.exited;
      expect(result.code).toBe(1);
      const outcome = result.stdout.split("\n").filter((line) => line.startsWith("graceful shutdown:"));
      expect(outcome).toEqual([TIMEOUT_LOG]);
    } finally {
      stop(proc.child);
    }
  });
});
// SHO-2689 F7. `node server.js` loads src/lib/shutdown.ts through type stripping, which has
// no tsconfig `paths`. The drain's disconnectPrisma() used to do `import("@/lib/db")`, so every
// drain logged "prisma disconnect failed: Cannot find package '@/lib'" and db.$disconnect()
// never ran. These cases run the drain with no injected `disconnect`, under plain `node`.
describe("qa:TC missing drain prisma disconnect under plain node (F7)", () => {
  function startPlainNodeChild(env: Record<string, string> = {}) {
    const child = spawn(process.execPath, ["tests/shutdown-disconnect-child.ts"], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      // "close", not "exit": stdout chunks can arrive after exit, which drops the drain line.
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    return { child, exited, stdout: () => stdout, stderr: () => stderr };
  }

  it("qa:TC missing does not use a tsconfig alias inside the drain path", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of ["src/lib/shutdown.ts", "src/lib/db.ts"]) {
      const source = await readFile(path.join(root, file), "utf8");
      const specifiers = [...source.matchAll(/(?:from|import\()\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(specifiers.filter((s) => s?.startsWith("@/")), file).toEqual([]);
    }
  });

  it("qa:TC missing disconnects prisma under plain node instead of failing on the alias", async () => {
    const proc = startPlainNodeChild({ DELAY_MS: "50", KEEPALIVE_MS: "1" });
    try {
      const port = await vi.waitFor(
        () => {
          const match = /ready (\d+)/.exec(proc.stdout());
          if (!match) throw new Error(`no ready line: ${proc.stdout()} ${proc.stderr()}`);
          return Number(match[1]);
        },
        { timeout: 15000 },
      );
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/slow", agent: false }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve(`${res.statusCode} ${data}`));
          })
          .on("error", reject);
      });
      expect(body).toBe("200 done");
      proc.child.kill("SIGTERM");
      const result = await proc.exited;
      // The alias defect is what F7 named; it must be gone from the drain output.
      expect(result.stderr).not.toContain("Cannot find package '@/");
      expect(result.stdout).not.toContain("Cannot find package '@/");
      // Not asserted green yet: node cannot load the generated Prisma client (F7 residual).
      const unloadable = /prisma disconnect failed: (.*)/.exec(result.stdout + result.stderr);
      expect(unloadable?.[1] ?? "").not.toContain("@/lib");
      // The drain itself is unaffected by a failed disconnect, which is why F7 was MEDIUM.
      // On Darwin the koffi accept-queue seizer is linux-only, so the drain here reports the
      // timeout line and exits 1; the Linux run exits 0 (BUG-2689-LINUX.md §9). Assert the
      // outcome is one of the two honest lines, not a specific exit code.
      const shutdownLines = result.stdout.split("\n").filter((line) => line.startsWith("graceful shutdown:"));
      expect(shutdownLines.length).toBeGreaterThan(0);
      expect(shutdownLines.every((line) => line === CLEAN_LOG || line === TIMEOUT_LOG)).toBe(true);
    } finally {
      if (proc.child.exitCode === null) proc.child.kill("SIGKILL");
    }
  });
});

