// Production SIGTERM drain (APL-2688). Builds this app and spawns server.js, the
// process systemd runs, with a CPU burner beside it. Not part of `npm test`:
// `next build` rewrites `.next` and would pull the rug out from under a live
// server. `npm test` excludes this file. Run: npx vitest run -c vitest.shutdown.config.mts
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CLEAN_LOG, TIMEOUT_LOG } from "../src/lib/shutdown";

const root = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://sho:sho@127.0.0.1:5432/sho_test?schema=public";

type Proc = ReturnType<typeof startServer>;

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

function startServer(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", "server.js"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: "0",
      SHO_BIND_HOST: "127.0.0.1",
      DATABASE_URL: databaseUrl,
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
    output: () => ({ stdout, stderr }),
    async waitForHits(n: number, ms = 30000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const count = stdout.split("sho-hit\n").length - 1;
        if (count >= n) return;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      throw new Error(`timed out waiting for ${n} sho-hit lines (saw ${stdout.split("sho-hit\n").length - 1})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    },
    waitFor(re: RegExp, ms = 30000) {
      const existing = stdout.match(re);
      if (existing) return Promise.resolve(existing);
      return new Promise<RegExpMatchArray>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${re}\nstdout:\n${stdout}\nstderr:\n${stderr}`)), ms);
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

/** Connect after the process has closed its listening socket. A 200 here means it is still serving. */
async function refuseAfterUnlisten(proc: Proc, port: number): Promise<{ refused: boolean; accepted200: boolean }> {
  await proc.waitFor(/sho unlistened/, 10_000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__shutdown_slow`, { signal: AbortSignal.timeout(500) });
    await res.body?.cancel();
    return { refused: false, accepted200: res.status === 200 };
  } catch {
    return { refused: true, accepted200: false };
  }
}

describe("production server.js SIGTERM", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: databaseUrl, NEXT_TELEMETRY_DISABLED: "1" },
    });
  }, 600_000);

  async function midFlight(concurrency: number) {
    const burners = startBurners();
    const proc: Proc = startServer({ SHUTDOWN_TEST_SLOW_MS: "1500", SHUTDOWN_DRAIN_MS: "15000" });
    try {
      const ready = await proc.waitFor(/sho ready (\d+)/, 120_000);
      const port = Number(ready[1]);
      const pending = Promise.all(
        Array.from({ length: concurrency }, () =>
          fetch(`http://127.0.0.1:${port}/__shutdown_slow`).then(async (res) => ({ status: res.status, body: await res.text() })),
        ),
      );
      await proc.waitForHits(concurrency);
      proc.child.kill("SIGTERM");
      const late = await refuseAfterUnlisten(proc, port);
      const settled = await pending;
      const result = await proc.exited;
      return { settled, late, result };
    } finally {
      stop(proc.child);
      stopBurners(burners);
    }
  }

  it("drains 40 in-flight requests under CPU contention", async () => {
    const { settled, late, result } = await midFlight(40);
    expect(settled).toHaveLength(40);
    for (const response of settled) {
      expect(response.status).toBe(200);
      expect(response.body).toContain("done");
    }
    expect(late.accepted200).toBe(false);
    expect(late.refused).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(CLEAN_LOG);
    expect(result.stdout).not.toContain(TIMEOUT_LOG);
  }, 120_000);

  it("drains 100 in-flight requests under CPU contention", async () => {
    const { settled, late, result } = await midFlight(100);
    expect(settled).toHaveLength(100);
    for (const response of settled) {
      expect(response.status).toBe(200);
      expect(response.body).toContain("done");
    }
    expect(late.accepted200).toBe(false);
    expect(late.refused).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(CLEAN_LOG);
    expect(result.stdout).not.toContain(TIMEOUT_LOG);
  }, 120_000);

  it("logs the timeout line and exits 1 when a request outlives the drain", async () => {
    const burners = startBurners();
    const proc = startServer({ SHUTDOWN_TEST_SLOW_MS: "5000", SHUTDOWN_DRAIN_MS: "800" });
    try {
      const ready = await proc.waitFor(/sho ready (\d+)/, 120_000);
      const port = Number(ready[1]);
      const pending = fetch(`http://127.0.0.1:${port}/__shutdown_slow`).catch((err: unknown) => err);
      await proc.waitForHits(1);
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
  }, 120_000);
});
