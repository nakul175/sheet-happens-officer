// SIGTERM drain (APL-2688). A child process runs the production shutdown hook
// against a real HTTP server, so the signal, the exit code, and an in-flight
// response are the ones systemd would see.
import http from "node:http";
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
    const proc = startChild({ DELAY_MS: "1500", DRAIN_MS: "5000" });
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

  it("does not hold the process open for an idle keep-alive socket", async () => {
    const proc = startChild({ DELAY_MS: "0", DRAIN_MS: "8000" });
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
        // keepAliveTimeout on the fixture is 5s. Idle sockets must not consume it.
        expect(Date.now() - started).toBeLessThan(3000);
        expect(result.stdout).toContain(CLEAN_LOG);
      } finally {
        agent.destroy();
      }
    } finally {
      stop(proc.child);
    }
  });
});
