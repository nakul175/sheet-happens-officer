// Production SIGTERM drain (APL-2688 / APL-2689). Builds this app and spawns real
// `next start` — the command Pam's tester runs — pinned to two cores, with a CPU
// burner on those cores. The droplet is 2 vCPU / 4 GiB behind Caddy. The burst
// matches that tester: connect every socket, write the request, SIGTERM 40ms
// later, then a new connection at +16ms and +143ms must be refused. `npm test`
// excludes this file because `next build` rewrites `.next`.
// Run: npx vitest run -c vitest.shutdown.config.mts
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLEAN_LOG, TIMEOUT_LOG } from "../src/lib/shutdown";
import { PW, SUPER_EMAIL } from "./helpers";

const root = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://sho:sho@127.0.0.1:5432/sho_test?schema=public";
// These tests sign up a ZZ-TEST account and delete it afterwards. Only ever against a local throwaway Postgres.
const dbHost = new URL(databaseUrl).hostname;
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(dbHost)) {
  throw new Error("tests/shutdown-next.test.ts only runs against a local Postgres (DATABASE_URL host must be localhost)");
}

function startBurners(): ChildProcess[] {
  // The droplet is 2 vCPU. Pin the load to two cores so accept() falls behind the
  // way it did there, and leave the other cores for this test process.
  // Short slices. Two tight spins on the only two cores would keep the server
  // off-CPU longer than the 16ms probe, which is harsher than the droplet.
  const code = "setInterval(() => { const end = Date.now() + 4; while (Date.now() < end) Math.sqrt(Math.random()); }, 0);";
  return Array.from({ length: 2 }, () => spawn("taskset", ["-c", "0,1", process.execPath, "-e", code], { stdio: "ignore" }));
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

type Entry = "next start" | "server.js";

function startNext(port: number, env: Record<string, string>, entry: Entry = "next start") {
  // server.js is the production entry (deploy/cloud-init.yaml). Droplets built before
  // it, and the pr8 staging preview, still run `next start`.
  const args =
    entry === "server.js"
      ? [process.execPath, "--import", "tsx", "server.js"]
      : [process.execPath, "node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"];
  const child = spawn("taskset", ["-c", "0,1", ...args], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      SHUTDOWN_TEST_SLOW_MS: "1",
      PORT: String(port),
      SHO_BIND_HOST: "127.0.0.1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  /** Date.now() when each `graceful shutdown:` line reached this process. */
  const outcomeAt = new Map<string, number>();
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
    for (const line of [CLEAN_LOG, TIMEOUT_LOG]) {
      if (!outcomeAt.has(line) && stdout.includes(line)) outcomeAt.set(line, Date.now());
    }
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
    outcomeAt,
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

type Settled = { status: number; body: string; reset: boolean; doneAt: number };

function readResponse(socket: net.Socket): Promise<Settled> {
  return new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => resolve({ status: 0, body: buf, reset: true, doneAt: Date.now() }), 20000);
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve({ status: 0, body: buf, reset: true, doneAt: Date.now() });
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const head = buf.split("\r\n\r\n")[0] ?? "";
      const status = Number(head.split(" ")[1]);
      resolve({ status: Number.isFinite(status) ? status : 0, body: buf, reset: !buf.includes("HTTP/"), doneAt: Date.now() });
    });
  });
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

/** Times match the droplet tester: a new TCP connection at +16ms and +143ms. */
function probeAt(port: number, t0: number, at: number): Promise<Probe> {
  const wait = Math.max(0, t0 + at - Date.now());
  return new Promise((resolve) => setTimeout(() => resolve(probe(port)), wait));
}

describe("qa:TC missing next start SIGTERM", () => {
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
      const t0 = Date.now();
      proc.child.kill("SIGTERM");
      const [late16, late143] = await Promise.all([probeAt(port, t0, 16), probeAt(port, t0, 143)]);
      const settled = await pending;
      const result = await proc.exited;
      return { settled, late16, late143, result, hits: proc.hits() - hitsBefore };
    } finally {
      stop(proc.child);
      stopBurners(burners);
    }
  }

  async function expectBurst(concurrency: number) {
    const { settled, late16, late143, result, hits } = await burst(concurrency);
    expect(hits).toBe(concurrency);
    expect(settled.filter((response) => response.reset)).toEqual([]);
    for (const response of settled) {
      expect(response.status).toBe(200);
      expect(response.body).toContain("done");
    }
    expect([late16, late143]).toEqual(["refused", "refused"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(CLEAN_LOG);
    expect(result.stdout).not.toContain(TIMEOUT_LOG);
  }

  it("qa:TC missing drains 6 requests and refuses connections at 16ms and 143ms", async () => {
    await expectBurst(6);
  }, 120_000);

  it("qa:TC missing drains 40 requests written 40ms before SIGTERM on two pinned cores", async () => {
    await expectBurst(40);
  }, 120_000);

  it("qa:TC missing drains 100 requests written 40ms before SIGTERM on two pinned cores", async () => {
    await expectBurst(100);
  }, 120_000);

  it("qa:TC missing logs the timeout line and exits 1 when a request outlives the drain", async () => {
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

// APL-2689. Oscar's staging run: N concurrent signed-in GET / requests, SIGTERM mid-flight.
// At dc678d0 this dropped 12 of 40 here (ECONNRESET, no response), still accepted new
// connections, logged the drained line and exited 0. Every request must now return 200,
// new connections must be refused, and the drained line must arrive after the last response.
describe("qa:TC missing signed-in GET / under SIGTERM (APL-2689)", () => {
  const outbox = mkdtempSync(path.join(tmpdir(), "sho-apl2689-"));
  const email = `nakul17+zz-test-apl2689-${Date.now().toString(36)}-${process.pid}@aplyd.com`;
  let cookie = "";
  let userId = "";

  // ZZ-TEST cleanup goes through the app's API, as the Super Admin, with no direct DB writes
  // (APL-2750). The burst servers are gone by now, so this starts one more on a free port.
  afterAll(async () => {
    try {
      if (userId) await deactivateThroughApi(userId);
    } finally {
      rmSync(outbox, { recursive: true, force: true });
    }
  }, 180_000);

  function outboxToken(to: string, subject: RegExp) {
    const mail = readdirSync(outbox)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(path.join(outbox, f), "utf8")) as { to?: string; subject?: string; text?: string })
      .filter((m) => m.to === to && subject.test(m.subject ?? ""))
      .at(-1);
    return mail?.text?.match(/token=([\w-]+)/)?.[1];
  }

  function sessionCookie(res: Response) {
    return res.headers.getSetCookie().map((line) => line.split(";")[0]).find((line) => line.startsWith("sho_session=")) ?? "";
  }

  async function deactivateThroughApi(id: string) {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const superEmails = process.env.SUPER_ADMIN_EMAILS || SUPER_EMAIL;
    const proc = startNext(port, { EMAIL_OUTBOX_DIR: outbox, APP_URL: base, SUPER_ADMIN_EMAILS: superEmails });
    try {
      await proc.waitFor(/Ready/, 120_000);
      // Same Super Admin account and password as tests/helpers superAdmin(). A fresh database needs signup and verify first.
      const created = await post(base, "/api/auth/signup", { name: "Root", email: SUPER_EMAIL, password: PW });
      if (created.status === 201) {
        const token = outboxToken(SUPER_EMAIL, /Verify/);
        expect(token, "Super Admin verification mail").toBeTruthy();
        expect((await post(base, "/api/auth/verify", { token })).status).toBe(200);
      }
      const signed = await post(base, "/api/auth/signin", { email: SUPER_EMAIL, password: PW });
      expect(signed.status, "Super Admin sign-in").toBe(200);
      const off = await fetch(`${base}/api/team/${id}/deactivate`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: sessionCookie(signed) },
        body: JSON.stringify({ reassign: "leaders" }),
      });
      expect(off.status, await off.text()).toBe(200);
      expect((await post(base, "/api/auth/signin", { email, password: PW })).status, "deactivated ZZ-TEST account cannot sign in").not.toBe(200);
    } finally {
      stop(proc.child);
    }
  }

  async function post(base: string, p: string, body: unknown) {
    return fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  /** Signs up once. The session lives in Postgres, so the cookie works on every later server. */
  async function signedInCookie(base: string) {
    if (cookie) return cookie;
    const created = await post(base, "/api/auth/signup", { name: "ZZ-TEST Shutdown", email, password: PW });
    expect(created.status, await created.text()).toBe(201);
    const token = outboxToken(email, /Verify/);
    expect(token, "verification mail").toBeTruthy();
    expect((await post(base, "/api/auth/verify", { token })).status).toBe(200);
    const signed = await post(base, "/api/auth/signin", { email, password: PW });
    expect(signed.status).toBe(200);
    cookie = sessionCookie(signed);
    userId = ((await signed.json()) as { user: { id: string } }).user.id;
    expect(cookie).not.toBe("");
    return cookie;
  }

  async function signedInBurst(entry: Entry, concurrency: number) {
    const burners = startBurners();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const proc = startNext(port, { SHUTDOWN_DRAIN_MS: "15000", EMAIL_OUTBOX_DIR: outbox, APP_URL: base }, entry);
    try {
      await proc.waitFor(entry === "server.js" ? /sho ready/ : /Ready/, 120_000);
      const session = await signedInCookie(base);
      // Warm-up, as on staging. Under `next start` this is also the request that installs the hook.
      const warmup = await fetch(`${base}/`, { headers: { cookie: session }, redirect: "manual" });
      expect(warmup.status).toBe(200);
      await warmup.text();
      const sockets = await Promise.all(Array.from({ length: concurrency }, () => openSocket(port)));
      const pending = Promise.all(sockets.map((socket) => readResponse(socket)));
      for (const socket of sockets) {
        socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${session}\r\nConnection: close\r\n\r\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      const t0 = Date.now();
      proc.child.kill("SIGTERM");
      const [late16, late143] = await Promise.all([probeAt(port, t0, 16), probeAt(port, t0, 143)]);
      const settled = await pending;
      const result = await proc.exited;
      return { settled, late16, late143, result, drainedAt: proc.outcomeAt.get(CLEAN_LOG) };
    } finally {
      stop(proc.child);
      stopBurners(burners);
    }
  }

  async function expectSignedInBurst(entry: Entry, concurrency: number) {
    const { settled, late16, late143, result, drainedAt } = await signedInBurst(entry, concurrency);
    const summary = settled.map((response) => (response.reset ? "reset" : String(response.status)));
    expect(summary, "every in-flight GET / returns 200").toEqual(Array(concurrency).fill("200"));
    for (const response of settled) expect(response.body).toContain("</html>");
    expect([late16, late143], "new connections after SIGTERM").toEqual(["refused", "refused"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(CLEAN_LOG);
    expect(result.stdout).not.toContain(TIMEOUT_LOG);
    expect(drainedAt, "drained line seen").toBeDefined();
    const lastDone = Math.max(...settled.map((response) => response.doneAt));
    expect(drainedAt!, "drained line only after the last response completed").toBeGreaterThanOrEqual(lastDone);
  }

  for (const entry of ["next start", "server.js"] as const) {
    it(`qa:TC missing ${entry}: 6 signed-in GET / mid-flight all return 200, exit 0`, async () => {
      await expectSignedInBurst(entry, 6);
    }, 180_000);

    it(`qa:TC missing ${entry}: 40 signed-in GET / mid-flight all return 200, exit 0`, async () => {
      await expectSignedInBurst(entry, 40);
    }, 180_000);
  }
});
