// Verify the role of the process that actually started after a release switch.
// Keep connection values in memory and emit only fixed, non-secret result codes.
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assessRuntimeRole, readRuntimeRole, runtimeConnectionString } from './verify-workspace-contract.mjs';

export function parseProcessEnvironment(bytes) {
  const result = Object.create(null);
  for (const entry of bytes.toString().split('\0').filter(Boolean)) {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error('STARTED_RUNTIME_ENV_INVALID');
    const name = entry.slice(0, separator);
    if ((name === 'DATABASE_URL' || name === 'DIRECT_DATABASE_URL') && name in result)
      throw new Error('STARTED_RUNTIME_ENV_INVALID');
    result[name] = entry.slice(separator + 1);
  }
  return result;
}

export function assessStartedEnvironment(actual, expected) {
  if (!actual.DATABASE_URL || !actual.DIRECT_DATABASE_URL ||
      !expected.DATABASE_URL || !expected.DIRECT_DATABASE_URL ||
      actual.DATABASE_URL !== expected.DATABASE_URL ||
      actual.DIRECT_DATABASE_URL !== expected.DIRECT_DATABASE_URL)
    return 'STARTED_RUNTIME_ENV_MISMATCH';
  return null;
}

export async function verifyStartedRuntimeRole({ pid, releaseRoot, expected = process.env, procRoot = '/proc' }) {
  if (!/^[1-9][0-9]*$/.test(String(pid))) throw new Error('STARTED_RUNTIME_PID_INVALID');
  const proc = path.join(procRoot, String(pid));
  if (await realpath(path.join(proc, 'cwd')) !== await realpath(releaseRoot))
    throw new Error('STARTED_RUNTIME_RELEASE_MISMATCH');
  const actual = parseProcessEnvironment(await readFile(path.join(proc, 'environ')));
  const environmentCode = assessStartedEnvironment(actual, expected);
  if (environmentCode) throw new Error(environmentCode);
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: runtimeConnectionString(actual.DATABASE_URL),
    connectionTimeoutMillis: 5000,
    query_timeout: 8000,
  });
  try {
    await client.connect();
    const roleCode = assessRuntimeRole({
      runtimeUrl: actual.DATABASE_URL,
      directUrl: actual.DIRECT_DATABASE_URL,
      role: await readRuntimeRole(client),
    });
    if (roleCode) throw new Error(roleCode);
  } finally {
    await client.end().catch(() => {});
  }
  return 'STARTED_RUNTIME_ROLE_OK';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [releaseRoot, pid] = process.argv.slice(2);
  verifyStartedRuntimeRole({ releaseRoot, pid })
    .then((code) => console.log(code))
    .catch((error) => {
      console.error(/^([A-Z_]+)$/.test(error?.message) ? error.message : 'STARTED_RUNTIME_ROLE_UNAVAILABLE');
      process.exitCode = 1;
    });
}
