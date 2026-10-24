// SIGTERM is what systemd sends on `systemctl restart sho`.
//
// `next start` (node_modules/next/dist/server/lib/start-server.js) registers its own
// SIGTERM handler in the HTTP server's `listening` callback, before request handlers
// and before instrumentation.register(). That handler calls server.close() — Node 22's
// http.Server.close() runs closeIdleConnections(), which destroys accepted sockets that
// do not yet have an in-progress response — then process.exit(143). NEXT_MANUAL_SIG_HANDLE
// skips that registration, but it is read in the listening callback. Setting it from
// instrumentation is too late, and in production NextServer.prepare() does not run
// register() at all; the hook runs later, inside the first RouteModule.prepare, after
// the `request` event. A counter attached there never sees sockets that are accepted
// but not yet parsed, so the process can log a clean drain while those sockets are reset.
//
// The reset itself is earlier than the idle sweep. A client can finish connect() and
// write the request before this process emits 'connection'. server.close() in that
// window drops the kernel accept queue, and those sockets die with ECONNRESET without
// ever reaching a handler. Waiting for the queue to drain through the event loop
// keeps the listener open (new connections are still accepted) and, on a 2-vCPU
// box, the queue is still not empty when that wait gives up (~840ms here, drops
// observed ~900ms later). Those sockets are not in the connection list, so a
// request counter still logs a clean drain.
//
// On SIGTERM a C handler listen(fd, 0)s first (new handshakes are refused while
// the completed queue stays accept()able), accept()s that queue, then
// shutdown(SHUT_RD)s the listening socket before returning. shutdown() first
// drops the queue, and accept() without listen(0) still takes a handshake that
// arrives while the loop is preempted. It tracks every
// socket from 'connection' (including the ones just pulled off the queue), holds
// closeIdleConnections() for the drain, and only then lets Node close the listener.
// Next's own server.close() takes the same path. A clean drain is logged only when
// the queue was seized and none of those sockets dropped. The wait stays inside
// SHUTDOWN_DRAIN_MS.

import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

export const CLEAN_LOG = "graceful shutdown: drained in-flight requests";
export const TIMEOUT_LOG = "graceful shutdown: drain timed out";

/** Default sits inside the 10–25s window and under systemd's 90s stop grace. */
export const DEFAULT_DRAIN_MS = 15_000;
const MIN_DRAIN_MS = 10_000;
const MAX_DRAIN_MS = 25_000;

type SocketPhase = "pending" | "handling" | "idle";
type Tracked = { phase: SocketPhase };

type ShutdownState = {
  installed: boolean;
  shuttingDown: boolean;
  /** While true, closeIdleConnections() is a no-op so an undispatched socket is not reset. */
  holdIdleSweep: boolean;
  /** The kernel accept queue could not be pulled before the listener was closed. */
  queueDrainFailed: boolean;
  dropped: number;
  sockets: Map<net.Socket, Tracked>;
};

const state: ShutdownState = ((globalThis as { __shoShutdown?: ShutdownState }).__shoShutdown ??= {
  installed: false,
  shuttingDown: false,
  holdIdleSweep: false,
  queueDrainFailed: false,
  dropped: 0,
  sockets: new Map(),
});

const originalCloseIdle = new WeakMap<http.Server, () => void>();
const originalClose = new WeakMap<http.Server, (cb?: (err?: Error) => void) => void>();

export type ShutdownOptions = {
  /** Override SHUTDOWN_DRAIN_MS. Tests and server.js (when the slow-request seam is on) pass this. */
  drainMs?: number;
  /** The listening server. server.js passes the one it created. Otherwise every listening HTTP server. */
  servers?: http.Server[];
  /** Runs after the drain attempt and before the process exits. */
  disconnect?: () => Promise<void>;
  /** Runs synchronously after the listening socket is closed. Tests wait on this before probing. */
  onStoppedAccepting?: () => void;
  log?: (line: string) => void;
  exit?: (code: number) => void;
};

/** Milliseconds to wait for in-flight requests. Out-of-range values use the default. */
export function shutdownDrainMs(env?: { SHUTDOWN_DRAIN_MS?: string }): number {
  const raw = (env ?? process.env).SHUTDOWN_DRAIN_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_DRAIN_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_DRAIN_MS || n > MAX_DRAIN_MS) return DEFAULT_DRAIN_MS;
  return n;
}

function isHttpServer(handle: unknown): handle is http.Server {
  if (handle instanceof http.Server) return true;
  if (handle == null || typeof handle !== "object") return false;
  const server = handle as http.Server;
  // instrumentation's bundled `http` can be a different module instance than the one
  // start-server.js used, so instanceof misses the real listener.
  return typeof server.closeIdleConnections === "function" && typeof server.close === "function" && typeof server.on === "function";
}

function listeningHttpServers(): http.Server[] {
  const getHandles = (process as NodeJS.Process & { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  if (typeof getHandles !== "function") return [];
  return getHandles.call(process).filter((handle): handle is http.Server => isHttpServer(handle) && handle.listening);
}

async function disconnectPrisma(): Promise<void> {
  // Relative, not the "@/lib/db" alias. systemd runs `node server.js`, which loads this
  // file through Node's type stripping; Node has no tsconfig `paths`, so the alias threw
  // "Cannot find package '@/lib'" on every drain and db.$disconnect() never ran
  // (SHO-2689 F7). The ".ts" suffix is what Node resolves; bundlers resolve it too.
  const { db } = await import("./db.ts");
  await db.$disconnect();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function track(socket: net.Socket): Tracked {
  const existing = state.sockets.get(socket);
  if (existing) return existing;
  const tracked: Tracked = { phase: "pending" };
  state.sockets.set(socket, tracked);
  socket.on("close", () => {
    // Idle means a response finished and the socket was only kept open for keep-alive.
    // Closing those at the end of the drain is not a dropped request.
    if (state.shuttingDown && tracked.phase !== "idle") state.dropped++;
    state.sockets.delete(socket);
  });
  return tracked;
}

type HttpMessage = http.ServerResponse & { finished?: boolean };

function noteSocket(socket: net.Socket) {
  const tracked = track(socket);
  if (tracked.phase === "idle") return;
  const msg = (socket as net.Socket & { _httpMessage?: HttpMessage })._httpMessage;
  if (msg && !msg.finished) {
    if (tracked.phase !== "handling") {
      tracked.phase = "handling";
      msg.once("finish", () => {
        tracked.phase = "idle";
      });
    }
    return;
  }
  if (msg?.finished) tracked.phase = "idle";
}

/** Sockets Node has already accept()ed. The kernel backlog is not in this list. */
function acceptedSockets(server: http.Server): net.Socket[] {
  const sym = Object.getOwnPropertySymbols(server).find((name) => String(name) === "Symbol(http.server.connections)");
  if (!sym) return [];
  const list = (server as unknown as Record<symbol, { all?: () => unknown[] }>)[sym];
  if (!list || typeof list.all !== "function") return [];
  const sockets: net.Socket[] = [];
  for (const item of list.all()) {
    if (!item || typeof item !== "object") continue;
    const socket = "socket" in item ? (item as { socket?: net.Socket }).socket : (item as net.Socket);
    if (socket && typeof socket.on === "function") sockets.push(socket);
  }
  return sockets;
}

function backfill(server: http.Server) {
  for (const socket of acceptedSockets(server)) noteSocket(socket);
}

// Linux x86_64 / arm64: O_NONBLOCK and SOCK_CLOEXEC. The droplet is Ubuntu amd64.
const SOCK_NONBLOCK = 0x800;
const SOCK_CLOEXEC = 0x80000;
const SHUT_RD = 0;
const EAGAIN = 11;
const EINTR = 4;
const EBADF = 9;
const ENOTCONN = 107;

type Libc = {
  accept4: (fd: number) => number;
  listen: (fd: number) => number;
  shutdown: (fd: number) => number;
  errno: () => number;
};

let libcCache: Libc | null | undefined;

type NativeAccept = {
  arm: (fd: number) => number;
  seized: () => boolean;
  ok: () => boolean;
  take: () => number[];
};

let nativeCache: NativeAccept | null | undefined;
let wakeSocket: net.Socket | null = null;

function loadNative(): NativeAccept | null {
  if (nativeCache !== undefined) return nativeCache;
  if (process.platform !== "linux") {
    nativeCache = null;
    return null;
  }
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const koffi = require("koffi") as {
      load: (name: string) => { func: (signature: string) => (...args: unknown[]) => unknown };
      alloc: (type: string, length: number) => unknown;
      decode: (value: unknown, type: string, length?: number) => unknown;
    };
    const so = path.join(process.cwd(), "src/lib/sho-accept.so");
    const lib = koffi.load(so);
    const arm = lib.func("int sho_arm(int fd)");
    const seized = lib.func("int sho_seized(void)");
    const seizeOk = lib.func("int sho_seize_ok(void)");
    const take = lib.func("int sho_take(int *out, int cap)");
    nativeCache = {
      arm: (fd) => arm(fd) as number,
      seized: () => (seized() as number) !== 0,
      ok: () => (seizeOk() as number) !== 0,
      take: () => {
        const out = koffi.alloc("int", 8192);
        const n = take(out, 8192) as number;
        if (n <= 0) return [];
        const decoded = koffi.decode(out, "int", n);
        if (typeof decoded === "number") return [decoded];
        if (Array.isArray(decoded) || ArrayBuffer.isView(decoded)) return Array.from(decoded as ArrayLike<number>, (fd) => Number(fd));
        return [];
      },
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`graceful shutdown: signal handler not installed (${detail})`);
    nativeCache = null;
  }
  return nativeCache;
}

function loadLibc(): Libc | null {
  if (libcCache !== undefined) return libcCache;
  if (process.platform !== "linux") {
    libcCache = null;
    return null;
  }
  try {
    // Resolve from the app root. instrumentation.register() is webpack-bundled, so a
    // relative require from the bundle would not find node_modules.
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const koffi = require("koffi") as {
      load: (name: string) => { func: (signature: string) => (...args: unknown[]) => unknown };
      decode: (value: unknown, type: string) => number;
    };
    const lib = koffi.load("libc.so.6");
    const accept4 = lib.func("int accept4(int sockfd, void *addr, void *addrlen, int flags)");
    const listen = lib.func("int listen(int sockfd, int backlog)");
    const shutdown = lib.func("int shutdown(int sockfd, int how)");
    const errnoLoc = lib.func("int *__errno_location(void)");
    libcCache = {
      accept4: (fd) => accept4(fd, null, null, SOCK_NONBLOCK | SOCK_CLOEXEC) as number,
      listen: (fd) => listen(fd, 0) as number,
      shutdown: (fd) => shutdown(fd, SHUT_RD) as number,
      errno: () => koffi.decode(errnoLoc(), "int"),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`graceful shutdown: cannot read the accept queue (${detail})`);
    libcCache = null;
  }
  return libcCache;
}

function listenFd(server: http.Server): number | null {
  const fd = (server as http.Server & { _handle?: { fd?: number } | null })._handle?.fd;
  return typeof fd === "number" && fd >= 0 ? fd : null;
}

/**
 * Take every completed handshake still sitting in the kernel queue, then refuse
 * new ones. shutdown(SHUT_RD) is synchronous: connect() fails with ECONNREFUSED
 * before uv_close runs. libuv's close of this fd is deferred to the next poll,
 * which is what left the listener open for ~800ms and then reset whatever had
 * not been accept()ed yet.
 */
function seizeAcceptQueue(server: http.Server): { fds: number[]; ok: boolean } {
  const lib = loadLibc();
  const fd = listenFd(server);
  if (!lib || fd == null) return { fds: [], ok: false };
  // Same order as the signal handler: refuse new handshakes before draining.
  lib.listen(fd);
  const fds: number[] = [];
  for (;;) {
    const client = lib.accept4(fd);
    if (client >= 0) {
      if (fds.length > 1_000_000) return { fds, ok: false };
      fds.push(client);
      continue;
    }
    const err = lib.errno();
    if (err === EINTR) continue;
    if (err === EAGAIN) break;
    return { fds, ok: false };
  }
  if (lib.shutdown(fd) !== 0) {
    const err = lib.errno();
    if (err !== ENOTCONN && err !== EBADF) return { fds, ok: false };
  }
  return { fds, ok: true };
}

function adopt(server: http.Server, fd: number) {
  try {
    const socket = new net.Socket({ fd, allowHalfOpen: true });
    socket.setNoDelay(true);
    track(socket);
    server.emit("connection", socket);
  } catch {
    state.dropped++;
    try {
      fs.closeSync(fd);
    } catch {
      // The socket owns the fd once net.Socket has taken it.
    }
  }
}

function holdIdleSweep(server: http.Server) {
  if (originalCloseIdle.has(server)) return;
  const orig = server.closeIdleConnections.bind(server);
  originalCloseIdle.set(server, orig);
  server.closeIdleConnections = () => {
    if (state.holdIdleSweep) return;
    orig();
  };
}

function guardNextClose(server: http.Server) {
  if (originalClose.has(server)) return;
  const orig = server.close.bind(server) as (cb?: (err?: Error) => void) => void;
  originalClose.set(server, orig);
  // Next's SIGTERM handler calls server.close() synchronously, which resets the
  // kernel queue. Seize that queue first, and do not defer the unlisten.
  server.close = ((cb?: (err?: Error) => void) => {
    state.holdIdleSweep = true;
    const seized = seizeAcceptQueue(server);
    if (!seized.ok) state.queueDrainFailed = true;
    try {
      orig(cb);
    } catch (err) {
      if (cb) cb(err instanceof Error ? err : undefined);
    }
    for (const fd of seized.fds) adopt(server, fd);
    backfill(server);
    return server;
  }) as http.Server["close"];
}

function watchServer(server: http.Server) {
  holdIdleSweep(server);
  guardNextClose(server);
  // Count from accept, not from the request handler. Next dispatches later, and a
  // socket in between is not in any request counter.
  server.on("connection", (socket) => {
    track(socket);
  });
  server.prependListener("request", (req, res) => {
    const tracked = track(req.socket);
    tracked.phase = "handling";
    res.once("finish", () => {
      tracked.phase = "idle";
    });
  });
  backfill(server);
}

/** Accepted, mid-response, or holding bytes of a request that has not finished. */
function inFlight(): number {
  let n = 0;
  for (const [socket, tracked] of state.sockets) {
    if (tracked.phase !== "idle" || socket.readableLength > 0) n++;
  }
  return n;
}

/**
 * Stop the listening socket. http.Server.close() also closeIdleConnections(),
 * which resets sockets that are accepted but not yet a parsed request. Swap that
 * out for this one call and put it back so the later idle sweep still works.
 */
function stopAccepting(server: http.Server) {
  if (!server.listening) return;
  // The saved close skips the wrapper so this unlisten is not deferred twice.
  // holdIdleSweep is already set, so the idle sweep inside close() does nothing.
  const orig = originalClose.get(server);
  try {
    if (orig) orig();
    else server.close();
  } catch {
    // Already closing. New connections are still refused once the handle is down.
  }
}

function closeIdle(server: http.Server) {
  const orig = originalCloseIdle.get(server);
  try {
    if (orig) orig();
    else server.closeIdleConnections();
  } catch {
    // The deadline still ends the process if idle sockets cannot be closed.
  }
}

/** True once nothing accepted is still waiting on a response, and none was dropped. */
async function waitForSockets(deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (inFlight() === 0) return state.dropped === 0;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(15, remaining));
  }
  return false;
}

function report(line: string, code: number, options: ShutdownOptions) {
  if (options.log || options.exit) {
    (options.log ?? ((message) => process.stdout.write(`${message}\n`)))(line);
    (options.exit ?? ((status) => process.exit(status)))(code);
    return;
  }
  // Flush the outcome line before exiting so the journal captures it.
  process.stdout.write(`${line}\n`, () => process.exit(code));
}

async function onSigterm(servers: http.Server[], options: ShutdownOptions) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  // Block Next's server.close() (and ours) from resetting accepted sockets that
  // have not been dispatched to a handler yet.
  state.holdIdleSweep = true;
  // Client aborts from before this signal are not a failed drain.
  state.dropped = 0;
  state.queueDrainFailed = false;
  const drainMs = options.drainMs != null && Number.isFinite(options.drainMs) && options.drainMs > 0 ? options.drainMs : shutdownDrainMs();
  const deadline = Date.now() + drainMs;
  // The C handler may already have accept()ed the kernel queue and refused new
  // handshakes, including while this thread was inside a synchronous chunk of
  // Next. JS cannot do that: it only runs when the event loop turns.
  const native = loadNative();
  const seized =
    native?.seized() && servers[0]
      ? [{ server: servers[0], fds: native.take(), ok: native.ok() }]
      : servers.map((server) => ({ server, ...seizeAcceptQueue(server) }));
  if (seized.some((item) => !item.ok)) state.queueDrainFailed = true;
  for (const server of servers) stopAccepting(server);
  options.onStoppedAccepting?.();
  if (process.env.SHUTDOWN_TEST_SLOW_MS) process.stdout.write("sho unlistened\n");
  for (const item of seized) {
    for (const fd of item.fds) adopt(item.server, fd);
  }
  for (const server of servers) backfill(server);
  const quiet = await waitForSockets(deadline);
  state.holdIdleSweep = false;
  for (const server of servers) closeIdle(server);
  // closeIdleConnections destroys sockets on a later turn; count those drops too.
  await sleep(0);
  const clean = quiet && state.dropped === 0 && inFlight() === 0 && !state.queueDrainFailed;
  try {
    await (options.disconnect ?? disconnectPrisma)();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`graceful shutdown: prisma disconnect failed: ${detail}`);
  }
  report(clean ? CLEAN_LOG : TIMEOUT_LOG, clean ? 0 : 1, options);
}

/**
 * Own SIGTERM for this process. server.js calls this with the http.Server it
 * listens on, before accept. The instrumentation hook is only a fallback for a
 * process that still goes through `next start`.
 */
export function installGracefulShutdown(options: ShutdownOptions = {}) {
  if (state.installed) return;
  const servers = options.servers ?? listeningHttpServers();
  if (servers.length === 0) {
    console.error("graceful shutdown: no listening HTTP server found; SIGTERM handling unchanged");
    return;
  }
  state.installed = true;
  for (const server of servers) watchServer(server);
  // Add ours before removing Next's. When the last SIGTERM listener goes, Node
  // closes the signal handle, and a SIGTERM that libuv has already queued but JS
  // has not dispatched yet is dropped. Under `next start` with no warm-up this
  // hook runs ~150ms after Ready; a SIGTERM in that window was lost and the
  // process hung until a second one. Keeping a listener throughout hands that
  // queued signal to onSigterm instead.
  const ours = () => {
    void onSigterm(servers, options);
  };
  process.on("SIGTERM", ours);
  for (const listener of process.listeners("SIGTERM")) {
    if (listener !== ours) process.removeListener("SIGTERM", listener as (...args: unknown[]) => void);
  }
  // Installed last so it replaces Node's handler. The C handler accept()s and
  // shutdown(SHUT_RD)s before it returns, including while JS is busy. A helper
  // thread does not: on 2 vCPU it was still waiting for a core at +16ms.
  armNative(servers, options);
}

function armNative(servers: http.Server[], options: ShutdownOptions) {
  const native = loadNative();
  if (!native) return;
  const armOne = (server: http.Server) => {
    const fd = listenFd(server);
    if (fd == null) return;
    const wakeFd = native.arm(fd);
    if (wakeFd < 0 || wakeSocket) return;
    wakeSocket = new net.Socket({ fd: wakeFd });
    wakeSocket.on("data", () => {
      void onSigterm(servers, options);
    });
    wakeSocket.unref();
  };
  for (const server of servers) {
    if (server.listening) armOne(server);
    else server.once("listening", () => armOne(server));
  }
}
