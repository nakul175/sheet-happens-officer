// Actual production entry and native signal handler, on owned loopback processes.
import { beforeAll, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assertLocalFixture } from './e2e/local-fixture-guard';

beforeAll(() => {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('LINUX_X64_NATIVE_QUALIFICATION_REQUIRED');
  assertLocalFixture(process.env.DATABASE_URL, process.env.APP_URL);
});

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('OWNED_CHILD_TIMEOUT')), ms); })]); }
  finally { clearTimeout(timer); }
}

for (const scenario of ['clean', 'timeout'] as const) it(`native SIGTERM ${scenario}: refuses new connections and reports the actual drain outcome`, async () => {
  const directory = 'test-results/native-shutdown'; mkdirSync(directory, { recursive: true });
  const slowMs = scenario === 'clean' ? 1000 : 10_000, drainMs = scenario === 'clean' ? 5000 : 200;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.js'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: '0', SHO_BIND_HOST: '127.0.0.1', SHUTDOWN_TEST_SLOW_MS: String(slowMs), SHUTDOWN_DRAIN_MS: String(drainMs) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', exitState: { code: number | null; signal: string | null } | undefined;
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once('exit', (code, signal) => { exitState = { code, signal }; resolve(exitState); }));
  child.on('error', (error) => { stderr += error.name + ': ' + error.message; });
  function output(pattern: RegExp): Promise<RegExpMatchArray> {
    const match = stdout.match(pattern); if (match) return Promise.resolve(match);
    return new Promise((resolve, reject) => {
      const finish = () => { child.stdout.off('data', inspect); child.off('exit', stopped); clearTimeout(timer); };
      const inspect = () => { const found = stdout.match(pattern); if (found) { finish(); resolve(found); } };
      const stopped = () => { finish(); reject(Error('OWNED_CHILD_EXITED_BEFORE_MARKER')); };
      const timer = setTimeout(() => { finish(); reject(Error('OWNED_CHILD_MARKER_TIMEOUT')); }, 15_000);
      child.stdout.on('data', inspect); child.once('exit', stopped);
      inspect();
    });
  }
  const report: Record<string, unknown> = { status: 'FAIL', scenario, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), slowMs, drainMs, cleanup: false };
  let request: http.ClientRequest | undefined;
  try {
    const port = Number((await output(/sho ready (\d+)/))[1]);
    const response = new Promise<{ status?: number; body: string; complete: boolean; error?: string }>((resolve) => {
      request = http.get({ host: '127.0.0.1', port, path: '/__shutdown_slow', agent: false }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body, complete: true }));
        res.on('aborted', () => resolve({ status: res.statusCode, body, complete: false, error: 'ABORTED' }));
        res.on('error', () => resolve({ status: res.statusCode, body, complete: false, error: 'RESPONSE_ERROR' }));
      });
      request.on('error', (error: NodeJS.ErrnoException) => resolve({ body: '', complete: false, error: error.code }));
    });
    await output(/sho-hit/);
    const signalledAt = performance.now(); expect(child.kill('SIGTERM')).toBe(true);
    await output(/sho unlistened/);
    const newConnection = await new Promise<string>((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(2000);
      socket.once('connect', () => { socket.destroy(); resolve('ACCEPTED'); });
      socket.once('error', (error: NodeJS.ErrnoException) => { socket.destroy(); resolve(error.code ?? 'UNKNOWN_ERROR'); });
      socket.once('timeout', () => { socket.destroy(); resolve('TIMED_OUT'); });
    });
    expect(newConnection).toBe('ECONNREFUSED');
    const exit = await bounded(exited, drainMs + 6000);
    const inFlight = await bounded(response, 2000);
    const native = stdout.match(/post-SIGTERM SYN drop window (\d+)us/);
    expect(native).not.toBeNull(); // The native handler seized the queue, not only JS fallback.
    expect(stderr).not.toContain('signal handler not installed');
    expect(exit.signal).toBeNull();
    if (scenario === 'clean') {
      expect(exit.code).toBe(0); expect(inFlight).toEqual({ status: 200, body: 'hit\ndone\n', complete: true });
      expect(stdout).toContain('graceful shutdown: drained in-flight requests');
      expect(stdout).not.toContain('graceful shutdown: drain timed out');
    } else {
      expect(exit.code).toBe(1); expect(inFlight.complete).toBe(false);
      expect(stdout).toContain('graceful shutdown: drain timed out');
      expect(stdout).not.toContain('graceful shutdown: drained in-flight requests');
    }
    Object.assign(report, { status: 'PASS', nativeDropWindowUs: Number(native![1]), newConnection, inFlight, exit, signalToExitMs: Math.round(performance.now() - signalledAt) });
  } finally {
    request?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await bounded(exited, 5000).catch(() => {});
    report.cleanup = !!exitState;
    writeFileSync(`${directory}/${scenario}.log`, stdout + '\nSTDERR\n' + stderr);
    writeFileSync(`${directory}/${scenario}.json`, JSON.stringify(report, null, 2) + '\n');
    expect(exitState, 'owned native test process must exit').toBeDefined();
  }
}, 30_000);
