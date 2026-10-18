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
// ever reaching a handler. Once a handler has started, the socket has an unfinished
// response and survives closeIdleConnections().
//
// Production listens from server.js, which sets NEXT_MANUAL_SIG_HANDLE and passes the
// http.Server it created. On SIGTERM this module tracks sockets from the 'connection'
// event, holds closeIdleConnections(), and lets the accept queue become connection
// events before unlisten. Next's own server.close() is wrapped to do the same, so a
// process still started with `next start` cannot reset accepted-but-undispatched
// sockets after the hook is installed. Then it waits for every accepted socket that
// has not finished a response, and closes only sockets that are idle after a response.
// The whole wait stays inside SHUTDOWN_DRAIN_MS. A clean drain is logged only when
// none of those sockets dropped.

import http from "node:http";
import type net from "node:net";

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
  dropped: number;
  sockets: Map<net.Socket, Tracked>;
};

const state: ShutdownState = ((globalThis as { __shoShutdown?: ShutdownState }).__shoShutdown ??= {
  installed: false,
  shuttingDown: false,
  holdIdleSweep: false,
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
  const { db } = await import("@/lib/db");
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
  // Next's own SIGTERM handler calls server.close(), which resets the accept queue
  // and closeIdleConnections(). Send that call through the same hold + yield.
  server.close = ((cb?: (err?: Error) => void) => {
    state.holdIdleSweep = true;
    void acceptQueued([server]).then(() => {
      backfill(server);
      try {
        orig(cb);
      } catch (err) {
        if (cb) cb(err instanceof Error ? err : undefined);
      }
    });
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

/**
 * SIGTERM can run before this poll's accept callbacks. server.close() then resets
 * the kernel queue and those sockets die with ECONNRESET, never reaching a handler.
 * Keep polling until the number of accept()ed sockets stops growing.
 */
async function acceptQueued(servers: http.Server[]): Promise<void> {
  // A single stable read is not enough under CPU contention: the accept queue
  // pauses between polls, and closing then resets the sockets still queued.
  const earliest = Date.now() + 40;
  const cap = earliest + 800;
  let previous = -1;
  let stable = 0;
  while (Date.now() < cap) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    let count = 0;
    for (const server of servers) count += acceptedSockets(server).length;
    if (count === previous) stable++;
    else stable = 0;
    previous = count;
    if (Date.now() >= earliest && stable >= 3) return;
  }
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
  const drainMs = options.drainMs != null && Number.isFinite(options.drainMs) && options.drainMs > 0 ? options.drainMs : shutdownDrainMs();
  const deadline = Date.now() + drainMs;
  // server.close() resets the kernel accept queue. Sockets the client already
  // connected, but Node has not emitted 'connection' for, die with ECONNRESET
  // and never reach a handler. Let that queue become connection events first.
  await acceptQueued(servers);
  for (const server of servers) backfill(server);
  for (const server of servers) stopAccepting(server);
  options.onStoppedAccepting?.();
  if (process.env.SHUTDOWN_TEST_SLOW_MS) process.stdout.write("sho unlistened\n");
  const quiet = await waitForSockets(deadline);
  state.holdIdleSweep = false;
  for (const server of servers) closeIdle(server);
  // closeIdleConnections destroys sockets on a later turn; count those drops too.
  await sleep(0);
  const clean = quiet && state.dropped === 0 && inFlight() === 0;
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
  process.removeAllListeners("SIGTERM");
  process.on("SIGTERM", () => {
    void onSigterm(servers, options);
  });
}
