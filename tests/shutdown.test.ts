// SIGTERM drain (APL-2688). A child process runs the production shutdown hook
// against a real HTTP server, so the signal, the exit code, and an in-flight
// response are the ones systemd would see.
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLEAN_LOG, DEFAULT_DRAIN_MS, shutdownDrainMs, TIMEOUT_LOG } from "../src/lib/shutdown";

const root = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

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

function probe(port: number): Promise<"refused" | "open"> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("refused");
    }, 300);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("open");
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve("refused");
    });
  });
}

function probeAt(port: number, t0: number, at: number): Promise<"refused" | "open"> {
  const wait = Math.max(0, t0 + at - Date.now());
  return new Promise((resolve) => setTimeout(() => resolve(probe(port)), wait));
}

describe("shutdownDrainMs", () => {
  it("uses 15s when the env var is missing or outside 10–25s", () => {
    expect(shutdownDrainMs({})).toBe(DEFAULT_DRAIN_MS);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "" })).toBe(DEFAULT_DRAIN_MS);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "nope" })).toBe(DEFAULT_DRAIN_MS);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "9999" })).toBe(DEFAULT_DRAIN_MS);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "25001" })).toBe(DEFAULT_DRAIN_MS);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "15000.5" })).toBe(DEFAULT_DRAIN_MS);
  });

  it("accepts an integer from 10s through 25s", () => {
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "10000" })).toBe(10_000);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "20000" })).toBe(20_000);
    expect(shutdownDrainMs({ SHUTDOWN_DRAIN_MS: "25000" })).toBe(25_000);
  });
});

describe("SIGTERM drain", () => {
  it("finishes an in-flight request, refuses a new one, disconnects, and exits 0", async () => {
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

  it("exits non-zero and logs the timeout line when the drain deadline passes", async () => {
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

  it("closes an idle keep-alive socket without waiting out the keep-alive timeout", async () => {
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

  it("returns 200 for 100 requests written before SIGTERM, including ones not yet dispatched", async () => {
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

  it("returns 200 for 40 connections accepted before SIGTERM whose requests arrive during the grace", async () => {
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

  it("refuses connections at 16ms and 143ms after SIGTERM", async () => {
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

  it("finishes 40 sockets that were only in the kernel queue while the loop was blocked", async () => {
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

  it("exits non-zero when an in-flight request is dropped", async () => {
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
