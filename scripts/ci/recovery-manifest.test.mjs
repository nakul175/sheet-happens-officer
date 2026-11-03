import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardRecoveryEnvironment, ownedDatabaseName, fingerprint, compareManifest } from './recovery-manifest.mjs';

const env = { CI: 'true', GITHUB_ACTIONS: 'true', DATABASE_URL: 'postgresql://sho:sho@localhost:5432/sho_test?schema=public', DIRECT_DATABASE_URL: 'postgresql://sho:sho@localhost:5432/sho_test?schema=public', RECOVERY_POSTGRES_CONTAINER: 'a'.repeat(64) };
test('recovery accepts only the pinned synthetic CI configuration', () => {
  assert.equal(guardRecoveryEnvironment(env).pathname, '/sho_test');
  for (const patch of [{ CI: 'false' }, { GITHUB_ACTIONS: '' }, { RECOVERY_POSTGRES_CONTAINER: 'postgres:16' }, { DIRECT_DATABASE_URL: 'postgresql://prod' }]) {
    assert.throws(() => guardRecoveryEnvironment({ ...env, ...patch }));
  }
});
test('recovery rejects remote, shared, credential and URL option overrides', () => {
  for (const url of [env.DATABASE_URL.replace('localhost', 'db.example.com'), env.DATABASE_URL.replace('sho_test', 'sho_staging'), env.DATABASE_URL.replace('sho:sho', 'doadmin:secret'), env.DATABASE_URL + '&host=prod', env.DATABASE_URL + '&schema=public', env.DATABASE_URL + '#override', env.DATABASE_URL.replace('5432','5433')]) {
    assert.throws(() => guardRecoveryEnvironment({ ...env, DATABASE_URL: url, DIRECT_DATABASE_URL: url }));
  }
});
test('only generated owned database identifiers are accepted', () => {
  assert.match(ownedDatabaseName('target', 'b'.repeat(24)), /^sho_recovery_target_[a-f0-9]{24}$/);
  for (const args of [['prod', 'b'.repeat(24)], ['target', '";DROP DATABASE sho_test;--'], ['source', '']]) assert.throws(() => ownedDatabaseName(...args));
});
test('content fingerprints ignore row order but detect same-count corruption and identity replacement', () => {
  const rows = ['{"id":"a","value":123456789012345.67}', '{"id":"b","value":null}'];
  assert.deepEqual(fingerprint(rows), fingerprint([...rows].reverse()));
  for (const changed of [[rows[0].replace('.67', '.68'), rows[1]], [rows[0].replace('"a"','"c"'), rows[1]]]) {
    assert.equal(fingerprint(changed).count, 2);
    assert.notEqual(fingerprint(changed).sha256, fingerprint(rows).sha256);
  }
});
test('comparison detects missing/extra tables and schema drift independently of data counts', () => {
  const expected = { 'table:Task': fingerprint(['one']), 'schema:indexes': fingerprint(['unique-index']) };
  assert.deepEqual(compareManifest(expected, structuredClone(expected)), []);
  assert.deepEqual(compareManifest(expected, { ...expected, 'schema:indexes': fingerprint([]) }), ['schema:indexes']);
  assert.deepEqual(compareManifest(expected, {}), ['schema:indexes', 'table:Task']);
  assert.deepEqual(compareManifest(expected, { ...expected, 'table:Unknown': fingerprint([]) }), ['table:Unknown']);
});
