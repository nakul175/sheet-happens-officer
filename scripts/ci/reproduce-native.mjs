import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = 'test-results/native-provenance';
mkdirSync(out, { recursive: true });
const report = { status: 'FAIL', commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), cleanup: false };
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
let temporary, phase = 'platform';
try {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const pin = JSON.parse(readFileSync('deploy/vendor-provenance.json', 'utf8')).nativeShutdown;
  phase = 'source-and-binary-pins';
  report.sourceSha256 = hash(pin.source); report.expectedBinarySha256 = hash(pin.binary);
  assert.equal(report.sourceSha256, pin.sourceSHA256); assert.equal(report.expectedBinarySha256, pin.binarySHA256);
  phase = 'compiler';
  report.compiler = run('gcc', ['--version']).split('\n')[0];
  report.compilerVersion = run('gcc', ['-dumpfullversion', '-dumpversion']).trim();
  report.compilerTarget = run('gcc', ['-dumpmachine']).trim();
  assert.match(report.compilerVersion, /^13\./); assert.equal(report.compilerTarget, 'x86_64-linux-gnu');
  temporary = mkdtempSync(join(tmpdir(), 'sho-native-rebuild-'));
  report.builds = [];
  phase = 'rebuild';
  for (let n = 1; n <= 2; n++) {
    const binary = join(temporary, `rebuild-${n}.so`);
    run('gcc', ['-O2', '-fPIC', '-shared', '-o', binary, pin.source]);
    const digest = hash(binary);
    writeFileSync(join(out, `rebuild-${n}.so`), readFileSync(binary));
    report.builds.push({ run: n, sha256: digest });
    assert.equal(digest, pin.binarySHA256);
  }
  phase = 'symbols-and-original-preservation';
  const symbols = (file) => run('nm', ['-D', '--defined-only', file]).trim().split('\n').map((line) => line.trim().split(/\s+/).at(-1)).sort();
  report.exportedSymbols = symbols(pin.binary);
  assert.deepEqual(symbols(join(temporary, 'rebuild-1.so')), report.exportedSymbols);
  assert.equal(hash(pin.source), pin.sourceSHA256); assert.equal(hash(pin.binary), pin.binarySHA256);
  report.status = 'BYTE_IDENTICAL_REBUILD_PASS';
} catch (error) {
  report.failure = { phase, code: error.code ?? 'CHECK_FAILED' };
  if (error.stderr) writeFileSync(join(out, 'compiler-error.log'), error.stderr);
  process.exitCode = 1;
} finally {
  try {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    report.cleanup = !temporary || !existsSync(temporary);
  } catch { report.status = 'FAIL'; process.exitCode = 1; }
  writeFileSync(join(out, 'rebuild.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, phase: report.failure?.phase, cleanup: report.cleanup, report: join(out, 'rebuild.json') }));
}
