// SIGTERM is what systemd sends on `systemctl restart sho` (see deploy/cloud-init.yaml).
// `next start` already closes its HTTP server on that signal, then exits 143 with no
// deadline and without disconnecting Prisma. systemd's TimeoutStopSec is unset, so the
// platform SIGKILL arrives at the 90s default. This handler owns SIGTERM instead.
//
// Node's http.Server.close() calls closeIdleConnections() immediately. That destroys
// accepted sockets whose request has not been parsed yet, so a burst of in-flight
// requests dies with no response while the server still looks idle. Stop accepting
// without that sweep, count requests from start to finish, wait until none are active
// plus one keep-alive timeout (so those sockets can be parsed and handled), and only
// then close idle connections. Everything stays inside SHUTDOWN_DRAIN_MS.

import http from "node:http";

export const CLEAN_LOG = "graceful shutdown: drained in-flight requests";
export const TIMEOUT_LOG = "graceful shutdown: drain timed out";

/** Default sits inside the 10–25s window and under systemd's 90s stop grace. */
export const DEFAULT_DRAIN_MS = 15_000;
const MIN_DRAIN_MS = 10_000;
const MAX_DRAIN_MS = 25_000;
/** Used when the server has no positive keepAliveTimeout (Node's own default is 5s). */
const DEFAULT_GRACE_MS = 5_000;

type ShutdownState = { installed: boolean; shuttingDown: boolean; active: number; dropped: number };

const state: ShutdownState = ((globalThis as { __shoShutdown?: ShutdownState }).__shoShutdown ??= {
  installed: false,
  shuttingDown: false,
  active: 0,
  dropped: 0,
});

export type ShutdownOptions = {
  /** Override SHUTDOWN_DRAIN_MS. Tests pass a short budget here. */
  drainMs?: number;
  /** Defaults to every listening HTTP server in this process. */
  servers?: http.Server[];
  /** Runs after the drain attempt and before the process exits. */
  disconnect?: () => Promise<void>;
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

function listeningHttpServers(): http.Server[] {
  const getHandles = (process as NodeJS.Process & { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  if (typeof getHandles !== "function") return [];
  return getHandles.call(process).filter((handle): handle is http.Server => handle instanceof http.Server && handle.listening);
}

async function disconnectPrisma(): Promise<void> {
  const { db } = await import("@/lib/db");
  await db.$disconnect();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long to leave accepted-but-unparsed sockets alone: the server's keep-alive timeout. */
function graceMs(servers: http.Server[]): number {
  let grace = 0;
  for (const server of servers) {
    if (typeof server.keepAliveTimeout === "number" && server.keepAliveTimeout > grace) grace = server.keepAliveTimeout;
  }
  return grace > 0 ? grace : DEFAULT_GRACE_MS;
}

function watchServer(server: http.Server) {
  // Runs before the app handler, so a synchronous res.end() is still observed.
  server.prependListener("request", (_req, res) => {
    state.active++;
    let finished = false;
    res.once("finish", () => {
      finished = true;
    });
    res.once("close", () => {
      state.active = Math.max(0, state.active - 1);
      if (!finished) state.dropped++;
    });
  });
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

/** True when active requests have stayed at 0 for the grace period and none were dropped. */
async function waitForRequests(grace: number, deadline: number): Promise<boolean> {
  let quietAt: number | null = null;
  while (Date.now() < deadline) {
    if (state.active === 0) {
      quietAt ??= Date.now();
      if (Date.now() - quietAt >= grace) return state.dropped === 0;
    } else {
      quietAt = null;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const untilQuiet = quietAt == null ? 15 : Math.max(1, grace - (Date.now() - quietAt));
    await sleep(Math.min(15, remaining, untilQuiet));
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
  for (const server of servers) stopAccepting(server);
  const quiet = await waitForRequests(graceMs(servers), deadline);
  for (const server of servers) closeIdle(server);
  // closeIdleConnections destroys sockets on a later turn; count those drops too.
  await sleep(0);
  const clean = quiet && state.dropped === 0 && state.active === 0;
  try {
    await (options.disconnect ?? disconnectPrisma)();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`graceful shutdown: prisma disconnect failed: ${detail}`);
  }
  report(clean ? CLEAN_LOG : TIMEOUT_LOG, clean ? 0 : 1, options);
}

/**
 * Own SIGTERM for this process. Call once the HTTP server is already listening
 * (Next.js runs `instrumentation.register` from the server's listening callback).
 * No-ops when no listening server can be found, so a missed lookup does not
 * exit out from under open requests.
 */
export function installGracefulShutdown(options: ShutdownOptions = {}) {
  if (state.installed) return;
  const servers = options.servers ?? listeningHttpServers();
  if (!options.servers && servers.length === 0) {
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
