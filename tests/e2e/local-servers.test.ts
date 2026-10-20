// APL-2728, Pam's outbox condition 2 on the failure path: when a mode server fails to start, the pool still
// stops every process it spawned and removes every temp outbox. Stand-in node processes play the servers,
// so this runs in `npm test` with no build, no database and no SHO_QA_PASS.
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LocalServers } from "./local-servers";

const node = process.execPath;
const answers = ["-e", "require('http').createServer((q, s) => s.end('{}')).listen(Number(process.env.PORT), '127.0.0.1')"];
const exitsAtOnce = ["-e", "process.exit(1)"];
const neverAnswers = ["-e", "setInterval(() => {}, 1e9)"];

const pools: LocalServers[] = [];
function newPool() {
  const pool = new LocalServers();
  pools.push(pool);
  return pool;
}
const start = (pool: LocalServers, label: string, args: string[], timeoutMs = 10_000) =>
  pool.start({ label: `test-${label}`, cwd: process.cwd(), bin: node, args: () => args, timeoutMs, env: ({ port }) => ({ ...process.env, PORT: String(port) }) });

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function gone(pid: number) {
  const deadline = Date.now() + 5_000;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}

afterEach(() => {
  for (const pool of pools.splice(0)) pool.release();
});

describe("qa:TC missing APL-2728 local mode servers clean up when a start fails", () => {
  it("qa:TC missing a server that exits at once: start rejects, and release removes its outbox", async () => {
    const pool = newPool();
    await expect(start(pool, "exit", exitsAtOnce)).rejects.toThrow(/never answered/);
    const [made] = pool.created;
    expect(made && existsSync(made.outbox), "the outbox was created before the failure").toBe(true);
    pool.release();
    expect(existsSync(made!.outbox)).toBe(false);
    expect(pool.created).toEqual([]);
  });

  it("qa:TC missing a server that never answers: start rejects, its process is stopped and its outbox removed", async () => {
    const pool = newPool();
    await expect(start(pool, "hang", neverAnswers, 800)).rejects.toThrow(/never answered/);
    const [made] = pool.created;
    expect(made?.pid).toBeTruthy();
    pool.release();
    expect(await gone(made!.pid!), "the hung process is stopped").toBe(true);
    expect(existsSync(made!.outbox)).toBe(false);
  });

  it("qa:TC missing one of three starts fails: startAll rejects only after all settle, and release stops the healthy servers too", async () => {
    const pool = newPool();
    await expect(pool.startAll([
      () => start(pool, "ok-a", answers),
      () => start(pool, "fail", exitsAtOnce),
      () => start(pool, "ok-b", answers),
    ])).rejects.toThrow(/never answered/);
    const made = pool.created;
    expect(made).toHaveLength(3);
    const healthy = made.filter((m) => m.pid && alive(m.pid));
    expect(healthy, "the two healthy servers were still running when startAll threw").toHaveLength(2);
    pool.release();
    for (const m of made) {
      expect(existsSync(m.outbox), m.outbox).toBe(false);
      if (m.pid) expect(await gone(m.pid), `pid ${m.pid}`).toBe(true);
    }
  });
});
