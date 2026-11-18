import { spawn } from 'node:child_process';
import { mkdirSync, statfsSync, writeFileSync } from 'node:fs';
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
const before = available();
let minimum = before;
const started = Date.now();
const sample = () => { const value = available(); if (value < minimum) minimum = value; };
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
  const receipt = {
    command: [command, ...args],
    durationMs: Date.now() - started,
    availableBytesBefore: before.toString(),
    minimumAvailableBytes: minimum.toString(),
    availableBytesAfter: after.toString(),
    peakTemporaryBytes: (before - minimum).toString(),
    exitCode,
  };
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.exitCode = exitCode;
}
