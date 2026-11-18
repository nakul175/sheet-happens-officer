// Real SQL contract check on the disposable CI PostgreSQL database.
// All fixture writes stay inside a rolled-back transaction.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { assessFunctionSearchPaths, assessWorkspaceContract, readFunctionSearchPaths, readWorkspaceCounts } from '../../deploy/verify-workspace-contract.mjs';

const url = process.env.DATABASE_URL;
assert.ok(url, 'CI database URL required');
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 8000 });
let transactionOpen = false;
try {
  await client.connect();
  await client.query('BEGIN');
  transactionOpen = true;
  const initial = await readWorkspaceCounts(client);
  assert.equal(assessFunctionSearchPaths(await readFunctionSearchPaths(client)), null);
  assert.deepEqual(initial, { workspaces: 0, foreignUsers: 0 });
  assert.equal(assessWorkspaceContract({ mode: undefined, ...initial }), 'WORKSPACE_COUNT_INVALID');

  const nonce = randomBytes(8).toString('hex');
  await client.query('INSERT INTO "Workspace" (id, name) VALUES ($1, $2)', [`audit-one-${nonce}`, 'Disposable CI one']);
  const one = await readWorkspaceCounts(client);
  assert.deepEqual(one, { workspaces: 1, foreignUsers: 0 });
  assert.equal(assessWorkspaceContract({ mode: undefined, ...one }), null);

  await client.query('INSERT INTO "Workspace" (id, name) VALUES ($1, $2)', [`audit-two-${nonce}`, 'Disposable CI two']);
  const two = await readWorkspaceCounts(client);
  assert.deepEqual(two, { workspaces: 2, foreignUsers: 0 });
  assert.equal(assessWorkspaceContract({ mode: undefined, ...two }), 'WORKSPACE_COUNT_INVALID');
  await client.query('ROLLBACK');
  transactionOpen = false;
  assert.deepEqual(await readWorkspaceCounts(client), initial);
  const cli = spawnSync(process.execPath, ['deploy/verify-workspace-contract.mjs'], {
    env: { ...process.env, DIRECT_DATABASE_URL: 'postgresql://wrong:wrong@127.0.0.1:1/wrong' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^WORKSPACE_COUNT_INVALID\s*$/);
  console.log('WORKSPACE_SQL_ZERO_ONE_TWO_PASS');
} finally {
  if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
  await client.end().catch(() => {});
}
