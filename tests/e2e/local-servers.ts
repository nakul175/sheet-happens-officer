// Local servers for story specs that start their own `next start` per mode (APL-2728).
// Each server gets its own mkdtemp outbox. The pool records an outbox before anything that can fail
// and a process as soon as it is spawned, so release() stops and removes everything this run made,
// including a server that failed to start and one that was still starting when another failed.
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export type LocalServer = { pid: number; port: number; outbox: string; base: string };
type Owned = { outbox: string; pid?: number };

export type StartOptions = {
  /** Part of the outbox folder name, e.g. "2728-admins". */
  label: string;
  cwd: string;
  /** The child's environment, built once the port and outbox are known. */
  env: (o: { port: number; outbox: string; base: string }) => NodeJS.ProcessEnv;
  bin?: string;
  args?: (port: number) => string[];
  timeoutMs?: number;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

/** Stops the process group a pool spawned, by its exact PID. */
function stop(pid: number) {
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

export class LocalServers {
  private owned: Owned[] = [];

  /** Every outbox and PID this pool has made and not yet released, failed starts included. */
  get created(): Readonly<Owned>[] {
    return this.owned.map((o) => ({ ...o }));
  }

  async start(o: StartOptions): Promise<LocalServer> {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const owned: Owned = { outbox: mkdtempSync(path.join(tmpdir(), `sho-${o.label}-`)) };
    this.owned.push(owned);
    const logFd = openSync(path.join(owned.outbox, "server.log"), "a");
    let child;
    try {
      child = spawn(o.bin ?? "npx", o.args ? o.args(port) : ["next", "start", "-H", "127.0.0.1", "-p", String(port)], {
        cwd: o.cwd, env: o.env({ port, outbox: owned.outbox, base }), detached: true, stdio: ["ignore", logFd, logFd],
      });
    } finally {
      closeSync(logFd);
    }
    child.on("error", () => { /* reported below as "did not start" */ });
    child.unref();
    owned.pid = child.pid;
    if (!child.pid) throw new Error(`${o.label} did not start`);
    const deadline = Date.now() + (o.timeoutMs ?? 60_000);
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return { pid: child.pid, port, outbox: owned.outbox, base };
      } catch { /* still booting */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    stop(child.pid);
    throw new Error(`${o.label} never answered /api/health`);
  }

  /** Waits for every start to settle, so none is still booting when the caller cleans up, then throws the first failure. */
  async startAll<T>(starts: (() => Promise<T>)[]): Promise<T[]> {
    const results = await Promise.allSettled(starts.map((s) => s()));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    return results.map((r) => (r as PromiseFulfilledResult<T>).value);
  }

  /** Stops every process and removes every outbox this pool made. Safe to call more than once. */
  release() {
    for (const o of this.owned.splice(0)) {
      if (o.pid) stop(o.pid);
      rmSync(o.outbox, { recursive: true, force: true });
    }
  }
}
