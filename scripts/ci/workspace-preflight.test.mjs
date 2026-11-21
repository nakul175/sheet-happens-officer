import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessFunctionSearchPaths, assessRuntimeRole, assessWorkspaceContract, runtimeConnectionString, runtimeDatabaseUrl } from '../../deploy/verify-workspace-contract.mjs';
import { assessStartedEnvironment, parseProcessEnvironment } from '../../deploy/verify-started-runtime-role.mjs';

test('release refuses ambiguous or unapproved workspace state', () => {
  assert.equal(assessWorkspaceContract({ mode: undefined, workspaces: 0, foreignUsers: 0 }), 'WORKSPACE_COUNT_INVALID');
  assert.equal(assessWorkspaceContract({ mode: undefined, workspaces: 2, foreignUsers: 0 }), 'WORKSPACE_COUNT_INVALID');
  assert.equal(assessWorkspaceContract({ mode: undefined, workspaces: 1, foreignUsers: 1 }), 'WORKSPACE_USER_MISMATCH');
  assert.equal(assessWorkspaceContract({ mode: 'true', workspaces: 1, foreignUsers: 0 }), 'WORKSPACE_MODE_UNAPPROVED');
  assert.equal(assessWorkspaceContract({ mode: undefined, workspaces: 1, foreignUsers: 0 }), null);
});

test('release guard selects the runtime database, not the admin migration database', () => {
  assert.equal(runtimeDatabaseUrl({ DATABASE_URL: 'runtime', DIRECT_DATABASE_URL: 'admin' }), 'runtime');
  assert.equal(runtimeDatabaseUrl({ DIRECT_DATABASE_URL: 'admin' }), null);
});

test('production preflight refuses admin identity and elevated runtime rights before a cut', () => {
  const valid = {
    runtimeUrl: 'postgresql://sho_app:synthetic@db.example.test/defaultdb?sslmode=require',
    directUrl: 'postgresql://doadmin:synthetic@db.example.test/defaultdb?sslmode=require',
    role: { connectedUser: 'sho_app', privilegedAttributes: false, databaseCreate: false,
      schemaUsage: true, schemaCreate: false, roleMemberships: 0, tablesTotal: 37,
      ownedTables: 0, tablesMissingDml: 0, tablesWithDdlLikeRights: 0 },
  };
  assert.equal(assessRuntimeRole(valid), null);
  assert.equal(assessRuntimeRole({ ...valid, runtimeUrl: valid.directUrl }), 'RUNTIME_ROLE_IDENTITY_INVALID');
  assert.equal(assessRuntimeRole({ ...valid, directUrl: valid.runtimeUrl }), 'RUNTIME_ROLE_IDENTITY_INVALID');
  assert.equal(assessRuntimeRole({ ...valid, role: { ...valid.role, connectedUser: 'doadmin' } }), 'RUNTIME_ROLE_IDENTITY_INVALID');
  for (const changed of [
    { databaseCreate: true }, { schemaCreate: true }, { privilegedAttributes: true },
    { roleMemberships: 1 }, { ownedTables: 1 }, { tablesWithDdlLikeRights: 1 },
  ]) assert.equal(assessRuntimeRole({ ...valid, role: { ...valid.role, ...changed } }), 'RUNTIME_ROLE_PRIVILEGED');
  for (const changed of [{ schemaUsage: false }, { tablesTotal: 0 }, { tablesMissingDml: 1 }])
    assert.equal(assessRuntimeRole({ ...valid, role: { ...valid.role, ...changed } }), 'RUNTIME_ROLE_GRANTS_INCOMPLETE');
  assert.equal(assessRuntimeRole({ ...valid, directUrl: undefined }), 'RUNTIME_ROLE_URL_INVALID');
});

test('preflight preserves the declared libpq TLS mode without changing the target', () => {
  const raw = 'postgresql://sho_app:synthetic@db.example.test/defaultdb?sslmode=require&sslrootcert=%2Ftmp%2Fca.pem';
  const parsed = new URL(runtimeConnectionString(raw));
  assert.equal(parsed.username, 'sho_app');
  assert.equal(parsed.pathname, '/defaultdb');
  assert.equal(parsed.searchParams.get('sslmode'), 'require');
  assert.equal(parsed.searchParams.get('sslrootcert'), '/tmp/ca.pem');
  assert.equal(parsed.searchParams.get('uselibpqcompat'), 'true');
  assert.equal(runtimeConnectionString('postgresql://sho_app:synthetic@db.example.test/defaultdb?sslmode=verify-full').includes('uselibpqcompat'), false);
});

test('started process must use the exact runtime and direct URLs that passed preflight', () => {
  const expected = { DATABASE_URL: 'postgresql://sho_app:synthetic@db/one',
    DIRECT_DATABASE_URL: 'postgresql://doadmin:synthetic@db/one' };
  const actual = parseProcessEnvironment(Buffer.from(`OTHER=value\0DATABASE_URL=${expected.DATABASE_URL}\0DIRECT_DATABASE_URL=${expected.DIRECT_DATABASE_URL}\0`));
  assert.equal(assessStartedEnvironment(actual, expected), null);
  assert.equal(assessStartedEnvironment({ ...actual, DATABASE_URL: expected.DIRECT_DATABASE_URL }, expected), 'STARTED_RUNTIME_ENV_MISMATCH');
  assert.equal(assessStartedEnvironment({ ...actual, DIRECT_DATABASE_URL: '' }, expected), 'STARTED_RUNTIME_ENV_MISMATCH');
  assert.equal(assessStartedEnvironment(actual, { ...expected, DIRECT_DATABASE_URL: undefined }), 'STARTED_RUNTIME_ENV_MISMATCH');
  assert.throws(() => parseProcessEnvironment(Buffer.from('DATABASE_URL=one\0DATABASE_URL=two\0')), /STARTED_RUNTIME_ENV_INVALID/);
});

test('release refuses missing, duplicate, or drifted trigger function search paths', () => {
  const clean = ['enforce_max_sections', 'enforce_task_section_in_project', 'holy_sheet_task_move']
    .map((name) => ({ name, config: 'search_path=public' }));
  assert.equal(assessFunctionSearchPaths(clean), null);
  assert.equal(assessFunctionSearchPaths(clean.slice(1)), 'CUSTOM_FUNCTION_PATH_DRIFT');
  assert.equal(assessFunctionSearchPaths([clean[0], clean[0], clean[2]]), 'CUSTOM_FUNCTION_PATH_DRIFT');
  assert.equal(assessFunctionSearchPaths([clean[0], { ...clean[1], config: 'search_path="$user", public' }, clean[2]]), 'CUSTOM_FUNCTION_PATH_DRIFT');
});

test('read-only workspace preflight runs before migration check, build and switch', () => {
  const release = readFileSync(new URL('../../deploy/release.sh', import.meta.url), 'utf8');
  const preflight = release.indexOf('node "$REL/deploy/verify-workspace-contract.mjs"');
  assert.ok(preflight > release.indexOf('npm ci --include=dev'));
  assert.ok(preflight < release.indexOf('prisma migrate status'));
  assert.ok(preflight < release.indexOf('npx next build'));
  assert.ok(preflight < release.indexOf('switch "$REL"'));
  const postStart = release.indexOf('node "$REL/deploy/verify-started-runtime-role.mjs"');
  assert.ok(postStart > release.indexOf('healthy "$REL"'));
  assert.ok(postStart < release.indexOf('log "healthy: $SHA is live"'));
  const source = readFileSync(new URL('../../deploy/verify-workspace-contract.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(UPDATE|DELETE|INSERT|ALTER|DROP|CREATE)\b/);
});
