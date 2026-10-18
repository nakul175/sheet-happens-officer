// SIGTERM is what systemd sends on `systemctl restart sho` (see deploy/cloud-init.yaml).
// `next start` already closes its HTTP server on that signal, then exits 143 with no
// deadline and without disconnecting Prisma. systemd's TimeoutStopSec is unset, so the
// platform SIGKILL arrives at the 90s default. This handler owns SIGTERM instead:
// stop accepting, drop idle keep-alives, finish in-flight requests within
// SHUTDOWN_DRAIN_MS, disconnect Prisma, then exit 0 or 1.

import http from "node:http";

export const CLEAN_LOG = "graceful shutdown: drained in-flight requests";
export const TIMEOUT_LOG = "graceful shutdown: drain timed out";

/** Default sits inside the 10–25s window and under systemd's 90s stop grace. */
export const DEFAULT_DRAIN_MS = 15_000;
const MIN_DRAIN_MS = 10_000;
const MAX_DRAIN_MS = 25_000;

type ShutdownState = { installed: boolean; shuttingDown: boolean };

const state: ShutdownState = ((globalThis as { __shoShutdown?: ShutdownState }).__shoShutdown ??= {
  installed: false,
  shuttingDown: false,
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
export function shutdownDrainMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SHUTDOWN_DRAIN_MS;
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

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    try {
      // Stop accepting. The callback fires once every remaining connection has ended.
      server.close(done);
    } catch {
      done();
      return;
    }
    try {
      // Caddy keeps idle upstream sockets open. Those are not in-flight requests;
      // leaving them would hold the process until Node's keep-alive timeout.
      server.closeIdleConnections();
    } catch {
      // The drain deadline still ends the process if idle sockets cannot be closed.
    }
  });
}

function waitForDrain(servers: http.Server[], drainMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (clean: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(clean);
    };
    const timer = setTimeout(() => finish(false), drainMs);
    Promise.all(servers.map(closeServer)).then(
      () => finish(true),
      () => finish(false),
    );
  });
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
  const drainMs = options.drainMs != null && Number.isFinite(options.drainMs) && options.drainMs > 0 ? options.drainMs : shutdownDrainMs();
  const clean = await waitForDrain(servers, drainMs);
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
  process.removeAllListeners("SIGTERM");
  process.on("SIGTERM", () => {
    void onSigterm(servers, options);
  });
}
