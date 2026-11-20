import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const secretNames = ['DATABASE_URL', 'DIRECT_DATABASE_URL', 'JOB_SECRET', 'SUITE_ACCOUNTS_CLIENT_SECRET', 'SUITE_BUGOFF_CLIENT_SECRET', 'STAGING_PASS', 'SHO_ADMIN_PASS', 'SHO_MEMBER_PASS', 'SHO_QA_PASS', 'SHARD_PASS'];
const values = [...new Set(secretNames.flatMap((name) => {
  const value = process.env[name];
  if (!value || value.length < 12) return [];
  return [value, encodeURIComponent(value)].filter((item) => item.length >= 12);
}))].map((value) => Buffer.from(value));

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
  if (values.some((value) => bytes.includes(value))) throw new Error('ARTIFACT_SECRET_MATCH');
}

try {
  if (process.argv.length < 3) throw new Error('ARTIFACT_PATH_REQUIRED');
  for (const target of process.argv.slice(2)) await scan(target);
  console.log('Artifact secret scan passed');
} catch (error) {
  console.error(`Artifact upload blocked: ${error.message}`);
  process.exitCode = 1;
}
