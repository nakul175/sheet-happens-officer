// Production SIGTERM drain (APL-2688 / APL-2689). Builds this app and spawns real
// `next start` — the command Pam's tester runs — with a CPU burner beside it.
// The burst matches that tester: connect every socket, write the request, SIGTERM
// 40ms later, without waiting for handlers. Sockets still between accept and
// dispatch must return 200. `npm test` excludes this file because `next build`
// rewrites `.next`. Run: npx vitest run -c vitest.shutdown.config.mts
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CLEAN_LOG, TIMEOUT_LOG } from "../src/lib/shutdown";

const root = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://sho:sho@127.0.0.1:5432/sho_test?schema=public";

function startBurners(): ChildProcess[] {
  const n = Math.min(4, Math.max(2, os.cpus().length));
  const code = "setInterval(() => { const end = Date.now() + 40; while (Date.now() < end) Math.sqrt(Math.random()); }, 0);";
  return Array.from({ length: n }, () => spawn(process.execPath, ["-e", code], { stdio: "ignore" }));
}

function stopBurners(burners: ChildProcess[]) {
  for (const burner of burners) {
    if (burner.exitCode == null && burner.signalCode == null) burner.kill("SIGKILL");
  }
}

function freePort(): Promise<number> {
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

function startNext(port: number, env: Record<string, string>) {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      SHUTDOWN_TEST_SLOW_MS: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const waiters: { re: RegExp; resolve: (match: RegExpMatchArray) => void }[] = [];
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
    hits: () => stdout.split("sho-hit\n").length - 1,
    waitFor(re: RegExp, ms = 30000) {
      const existing = stdout.match(re);
      if (existing) return Promise.resolve(existing);
      return new Promise<RegExpMatchArray>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${re}\nstdout:\n${stdout.slice(-2000)}\nstderr:\n${stderr.slice(-2000)}`)), ms);
        waiters.push({
          re,
          resolve: (match) => {
            clearTimeout(timer);
            resolve(match);
          },
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
      socket.on("error", () => {});
      resolve(socket);
    };
    socket.once("error", fail);
    socket.once("connect", onConnect);
  });
}

function readResponse(socket: net.Socket): Promise<{ status: number; body: string; reset: boolean }> {
  return new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => resolve({ status: 0, body: buf, reset: true }), 20000);
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve({ status: 0, body: buf, reset: true });
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const head = buf.split("\r\n\r\n")[0] ?? "";
      const status = Number(head.split(" ")[1]);
      resolve({ status: Number.isFinite(status) ? status : 0, body: buf, reset: !buf.includes("HTTP/") });
    });
  });
}

/** Connect only after the process has unlistened, so the probe is not another in-flight socket. */
function connectAfterUnlisten(proc: ReturnType<typeof startNext>, port: number): Promise<"refused" | "open"> {
  return proc.waitFor(/sho unlistened/, 10_000).then(
    () =>
      new Promise((resolve) => {
        const socket = net.connect({ port, host: "127.0.0.1" });
        const timer = setTimeout(() => {
          socket.destroy();
          resolve("refused");
        }, 500);
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.end();
          resolve("open");
        });
        socket.once("error", () => {
          clearTimeout(timer);
          resolve("refused");
        });
      }),
  );
}

describe("next start SIGTERM", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: databaseUrl, NEXT_TELEMETRY_DISABLED: "1" },
    });
  }, 600_000);

  async function burst(concurrency: number) {
    const burners = startBurners();
    const port = await freePort();
    const proc = startNext(port, { SHUTDOWN_DRAIN_MS: "15000" });
    try {
      await proc.waitFor(/Ready/, 120_000);
      // First request installs the SIGTERM hook. Next does not run register() at listen.
      const warmup = await fetch(`http://127.0.0.1:${port}/api/shutdown-slow?ms=0`);
      expect(warmup.status).toBe(200);
      const hitsBefore = proc.hits();
      const sockets = await Promise.all(Array.from({ length: concurrency }, () => openSocket(port)));
      const pending = Promise.all(sockets.map((socket) => readResponse(socket)));
      for (const socket of sockets) {
        socket.write(`GET /api/shutdown-slow?ms=2000 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      proc.child.kill("SIGTERM");
      const late = await connectAfterUnlisten(proc, port);
      const settled = await pending;
      const result = await proc.exited;
      return { settled, late, result, hits: proc.hits() - hitsBefore };
    } finally {
      stop(proc.child);
      stopBurners(burners);
    }
  }

  it("drains 40 requests written 40ms before SIGTERM under CPU contention", async () => {
    const { settled, late, result, hits } = await burst(40);
    expect(hits).toBe(40);
    expect(settled.filter((response) => response.reset)).toEqual([]);
    for (const response of settled) {
      expect(response.status).toBe(200);
      expect(response.body).toContain("done");
    }
    expect(late).toBe("refused");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(CLEAN_LOG);
    expect(result.stdout).not.toContain(TIMEOUT_LOG);
  }, 120_000);

  it("drains 100 requests written 40ms before SIGTERM under CPU contention", async () => {
    const { settled, late, result, hits } = await burst(100);
    expect(hits).toBe(100);
    expect(settled.filter((response) => response.reset)).toEqual([]);
    for (const response of settled) {
      expect(response.status).toBe(200);
      expect(response.body).toContain("done");
    }
    expect(late).toBe("refused");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(CLEAN_LOG);
    expect(result.stdout).not.toContain(TIMEOUT_LOG);
  }, 120_000);

  it("logs the timeout line and exits 1 when a request outlives the drain", async () => {
    const burners = startBurners();
    const port = await freePort();
    const proc = startNext(port, { SHUTDOWN_DRAIN_MS: "10000" });
    try {
      await proc.waitFor(/Ready/, 120_000);
      const pending = fetch(`http://127.0.0.1:${port}/api/shutdown-slow?ms=20000`).catch((err: unknown) => err);
      await proc.waitFor(/sho-hit/);
      proc.child.kill("SIGTERM");
      const result = await proc.exited;
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(TIMEOUT_LOG);
      expect(result.stdout).not.toContain(CLEAN_LOG);
      await pending;
    } finally {
      stop(proc.child);
      stopBurners(burners);
    }
  }, 60_000);
});
