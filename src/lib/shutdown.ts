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
// Production therefore listens from server.js, which sets NEXT_MANUAL_SIG_HANDLE and
// passes the http.Server it created. On SIGTERM this module unlistens first (without
// the idle sweep), then waits for every accepted socket that has not finished a
// response, then closes only sockets that are idle after a response. The whole wait
// stays inside SHUTDOWN_DRAIN_MS.

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
  dropped: number;
  sockets: Map<net.Socket, Tracked>;
};

const state: ShutdownState = ((globalThis as { __shoShutdown?: ShutdownState }).__shoShutdown ??= {
  installed: false,
  shuttingDown: false,
  dropped: 0,
  sockets: new Map(),
});

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

function watchServer(server: http.Server) {
  server.on("connection", (socket) => {
    track(socket);
  });
  // If a request is observed without a connection event (already-accepted socket),
  // count it from here. prepend so a synchronous res.end() is still observed.
  server.prependListener("request", (req, res) => {
    const tracked = track(req.socket);
    tracked.phase = "handling";
    res.once("finish", () => {
      tracked.phase = "idle";
    });
  });
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
  const closeIdle = server.closeIdleConnections;
  server.closeIdleConnections = () => {};
  try {
    server.close();
  } catch {
    // Already closing. New connections are still refused once the handle is down.
  } finally {
    server.closeIdleConnections = closeIdle;
  }
}

function closeIdle(server: http.Server) {
  try {
    server.closeIdleConnections();
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
  // Client aborts from before this signal are not a failed drain.
  state.dropped = 0;
  const drainMs = options.drainMs != null && Number.isFinite(options.drainMs) && options.drainMs > 0 ? options.drainMs : shutdownDrainMs();
  const deadline = Date.now() + drainMs;
  // Unlisten before counting so a connection that arrives after SIGTERM is not served.
  for (const server of servers) stopAccepting(server);
  options.onStoppedAccepting?.();
  const quiet = await waitForSockets(deadline);
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
