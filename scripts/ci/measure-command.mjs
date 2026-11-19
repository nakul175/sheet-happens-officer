import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const separator = process.argv.indexOf('--');
if (separator < 3 || separator === process.argv.length - 1) {
  console.error('Usage: node measure-command.mjs RECEIPT.json -- COMMAND [ARGS...]');
  process.exit(2);
}

const receiptPath = process.argv[2];
const [command, ...args] = process.argv.slice(separator + 1);
const available = () => {
  const { bsize, bavail } = statfsSync(process.cwd(), { bigint: true });
  return bsize * bavail;
};
const memoryAvailableKiB = () => {
  try {
    const source = readFileSync(process.env.BUILD_CAPACITY_MEMINFO_PATH || '/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(source);
    return match ? BigInt(match[1]) : null;
  } catch { return null; }
};
const before = available();
let minimum = before;
const memoryBefore = memoryAvailableKiB();
let minimumMemory = memoryBefore;
const started = Date.now();
const sample = () => {
  const value = available(); if (value < minimum) minimum = value;
  const memory = memoryAvailableKiB();
  if (memory !== null && (minimumMemory === null || memory < minimumMemory)) minimumMemory = memory;
};
const timer = setInterval(sample, 250);
const child = spawn(command, args, { stdio: 'inherit', env: process.env });
child.on('error', (error) => {
  console.error(error);
  finish(127);
});
child.on('exit', (code, signal) => finish(code ?? (signal ? 128 : 1)));
let finished = false;
function finish(exitCode) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  sample();
  const after = available();
  const memoryAfter = memoryAvailableKiB();
  const receipt = {
    command: [command, ...args],
    durationMs: Date.now() - started,
    availableBytesBefore: before.toString(),
    minimumAvailableBytes: minimum.toString(),
    availableBytesAfter: after.toString(),
    peakTemporaryBytes: (before - minimum).toString(),
    memoryAvailableKiBBefore: memoryBefore?.toString() ?? null,
    minimumMemoryAvailableKiB: minimumMemory?.toString() ?? null,
    memoryAvailableKiBAfter: memoryAfter?.toString() ?? null,
    exitCode,
  };
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.exitCode = exitCode;
}
