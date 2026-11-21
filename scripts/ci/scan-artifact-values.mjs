import { lstat, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const secretNames = ['DATABASE_URL', 'DIRECT_DATABASE_URL', 'JOB_SECRET', 'SUITE_ACCOUNTS_CLIENT_SECRET', 'SUITE_BUGOFF_CLIENT_SECRET', 'STAGING_PASS', 'SHO_ADMIN_PASS', 'SHO_MEMBER_PASS', 'SHO_QA_PASS', 'SHARD_PASS', 'PEER_PASS'];
const configured = secretNames.flatMap((name) => {
  const value = process.env[name];
  if (!value) return [];
  return [value, encodeURIComponent(value)];
});
if (process.env.STAGING_USER && process.env.STAGING_PASS) {
  configured.push(Buffer.from(`${process.env.STAGING_USER}:${process.env.STAGING_PASS}`).toString('base64'));
}
const values = [...new Set(configured)].map((value) => Buffer.from(value));

function unzip(target, entry) {
  const args = entry === undefined ? ['-Z1', target] : ['-p', target, entry];
  const result = spawnSync('unzip', args, { maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('ARTIFACT_ZIP_UNREADABLE');
  return result.stdout;
}

function assertNoValues(bytes) {
  if (values.some((value) => bytes.includes(value))) throw new Error('ARTIFACT_SECRET_MATCH');
}

function scanZip(target) {
  const names = unzip(target).toString('utf8').trimEnd().split('\n');
  if (!names.length || names.length > 10000) throw new Error('ARTIFACT_ZIP_UNSUPPORTED');
  for (const name of names) {
    if (!/^[\w./-]+$/.test(name) || name.includes('..') || name.endsWith('.zip')) {
      throw new Error('ARTIFACT_ZIP_UNSUPPORTED');
    }
    if (!name.endsWith('/')) assertNoValues(unzip(target, name));
  }
}

async function scan(target) {
  let stat;
  try { stat = await lstat(target); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error('ARTIFACT_SYMLINK');
  if (stat.isDirectory()) {
    for (const entry of await readdir(target)) await scan(path.join(target, entry));
    return;
  }
  if (!stat.isFile()) throw new Error('ARTIFACT_UNSUPPORTED_TYPE');
  const bytes = await readFile(target);
  assertNoValues(bytes);
  if (target.endsWith('.zip')) scanZip(target);
}

try {
  if (process.argv.length < 3) throw new Error('ARTIFACT_PATH_REQUIRED');
  for (const target of process.argv.slice(2)) await scan(target);
  console.log('Artifact secret scan passed');
} catch (error) {
  console.error(`Artifact upload blocked: ${error.message}`);
  process.exitCode = 1;
}
