// Synthetic CI recovery tooling exercise. Never a production-backup certificate.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { guardRecoveryEnvironment, ownedDatabaseName, sha256, databaseManifest, compareManifest } from './recovery-manifest.mjs';

const report = { status: 'FAIL', scope: 'synthetic-disposable-ci-only', productionRecoveryCertified: false, startedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), checks: {}, cleanup: false };
const output = 'test-results/recovery';
mkdirSync(output, { recursive: true });
let phase = 'containment', admin, temp;
const owned = [], clients = [];
const run = (command, args, options = {}) => execFileSync(command, args, { timeout: 120_000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
try {
  const base = guardRecoveryEnvironment(process.env);
  const container = process.env.RECOVERY_POSTGRES_CONTAINER;
  const docker = (args, options) => run('docker', args, options);
  const inspect = JSON.parse(docker(['inspect', container]).toString())[0];
  assert.equal(inspect.Id, container);
  assert.equal(inspect.Config.Image, 'postgres:16');
  for (const entry of ['POSTGRES_USER=sho', 'POSTGRES_PASSWORD=sho', 'POSTGRES_DB=sho_test']) assert.ok(inspect.Config.Env.includes(entry));
  const { default: pg } = await import('pg');
  const connect = async (database) => {
    const url = new URL(base); url.pathname = '/' + database;
    const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 30_000 });
    clients.push(client); await client.connect(); return client;
  };
  admin = await connect('sho_test');
  const systemId = (await admin.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
  const containerId = docker(['exec', container, 'psql', '-U', 'sho', '-d', 'sho_test', '-Atc', 'SELECT system_identifier::text FROM pg_control_system()']).toString().trim();
  assert.equal(systemId, containerId);
  assert.match(containerId, /^\d+$/);
  report.checks.serviceIdentity = 'PASS';
  report.postgresVersion = (await admin.query('SHOW server_version')).rows[0].server_version;
  report.dumpVersion = docker(['exec', container, 'pg_dump', '--version']).toString().trim();
  phase = 'migration-baseline';
  const baseline = JSON.parse(readFileSync('deploy/schema-baseline.json', 'utf8')).migrations;
  const names = readdirSync('prisma/migrations').filter((name) => /^\d/.test(name)).sort();
  assert.deepEqual(names, Object.keys(baseline).sort());
  for (const name of names) assert.equal(sha256(readFileSync(`prisma/migrations/${name}/migration.sql`)), baseline[name]);
  const nonce = randomBytes(12).toString('hex');
  const sourceName = ownedDatabaseName('source', nonce), targetName = ownedDatabaseName('target', nonce);
  report.ownedDatabases = owned;
  phase = 'create-owned-databases';
  for (const database of [sourceName, targetName]) {
    // No IF NOT EXISTS: collision must fail, and cleanup may only drop our creations.
    await admin.query(`CREATE DATABASE "${database}"`); owned.push(database);
  }
  phase = 'replay-existing-migrations';
  const sourceUrl = new URL(base); sourceUrl.pathname = '/' + sourceName;
  run('node_modules/.bin/prisma', ['migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: sourceUrl.toString(), DIRECT_DATABASE_URL: sourceUrl.toString() } });
  const source = await connect(sourceName), target = await connect(targetName);
  const history = (await source.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name')).rows;
  assert.equal(history.length, names.length);
  for (const row of history) { assert.equal(row.checksum, baseline[row.migration_name]); assert.ok(row.finished_at); assert.equal(row.rolled_back_at, null); }
  report.migrationCount = history.length;
  phase = 'seed-synthetic-records';
  const seed = `
    INSERT INTO "Workspace" (id,name) VALUES ('recovery-w','Synthetic recovery');
    INSERT INTO "User" (id,"workspaceId",email,name,"passwordHash") VALUES ('recovery-u','recovery-w','recovery@example.invalid','Synthetic user','not-a-login-hash');
    INSERT INTO "Project" (id,"workspaceId",name,"updatedAt") VALUES ('recovery-p','recovery-w','Synthetic project',now());
    INSERT INTO "Section" (id,"projectId",name,position,"isDone") VALUES ('recovery-s','recovery-p','Done',0,true);
    INSERT INTO "Task" (id,"workspaceId","projectId","sectionId",title,"assigneeId","createdById","updatedAt") VALUES ('recovery-t','recovery-w','recovery-p','recovery-s','Snapshot title — Unicode ✓','recovery-u','recovery-u',now());
    INSERT INTO "DealDetails" ("projectId","workspaceId","whyPursue",value,"submissionDeadline") VALUES ('recovery-p','recovery-w','Synthetic drill',12345678901234.56,'2026-10-29');
  `;
  for (const [index, sql] of seed.split(';').map((sql) => sql.trim()).filter(Boolean).entries()) {
    phase = 'seed-' + ['workspace', 'user', 'project', 'section', 'task', 'deal'][index];
    await source.query(sql);
  }
  phase = 'capture-independent-source-reference';
  // No writers exist in this private source. Capture BEFORE dump/restore, never
  // derive expected content from the restored target or a moving live database.
  const reference = await databaseManifest(source);
  writeFileSync(join(output, 'source-reference.json'), JSON.stringify(reference, null, 2) + '\n');
  report.referenceSha256 = sha256(readFileSync(join(output, 'source-reference.json')));
  phase = 'dump-and-restore';
  temp = mkdtempSync(join(tmpdir(), 'sho-recovery-'));
  const started = performance.now();
  const dump = docker(['exec', container, 'pg_dump', '-U', 'sho', '-d', sourceName, '--format=custom']);
  const dumpPath = join(temp, 'snapshot.dump');
  writeFileSync(dumpPath, dump, { mode: 0o600 });
  report.dumpSha256 = sha256(dump); report.dumpBytes = dump.length;
  // Demonstrate that later source writes do not invalidate the snapshot oracle.
  await source.query('UPDATE "Task" SET title=$1 WHERE id=$2', ['After backup', 'recovery-t']);
  assert.deepEqual(compareManifest(reference, await databaseManifest(source)), ['table:Task']);
  docker(['exec', '-i', container, 'pg_restore', '-U', 'sho', '-d', targetName, '--no-owner', '--no-privileges', '--exit-on-error'], { input: readFileSync(dumpPath) });
  report.dumpRestoreMilliseconds = Math.round(performance.now() - started);
  phase = 'verify-restored-content-and-schema';
  const restored = await databaseManifest(target);
  writeFileSync(join(output, 'restored-manifest.json'), JSON.stringify(restored, null, 2) + '\n');
  assert.deepEqual(compareManifest(reference, restored), []);
  report.checks.snapshotContentAndSchema = 'PASS';
  const legacy = (await target.query(`SELECT "submissionDeadline"::text AS legacy,"submissionDeadlineAt","submissionDeadlineZone",value::text FROM "DealDetails" WHERE "projectId"='recovery-p'`)).rows[0];
  assert.deepEqual(legacy, { legacy: '2026-10-29', submissionDeadlineAt: null, submissionDeadlineZone: null, value: '12345678901234.56' });
  report.checks.legacyDateNullDeadlineAndDecimal = 'PASS';
  phase = 'restored-database-write-and-constraint-smoke';
  await target.query('BEGIN');
  await target.query(`UPDATE "Task" SET title='Smoke write' WHERE id='recovery-t'`);
  assert.equal((await target.query(`SELECT title FROM "Task" WHERE id='recovery-t'`)).rows[0].title, 'Smoke write');
  await target.query('ROLLBACK');
  for (const [sql, code] of [
    [`INSERT INTO "Section" (id,"projectId",name,position,"isDone") VALUES ('invalid-done','recovery-p','Second done',1,true)`, '23505'],
    [`UPDATE "Task" SET "assigneeId"='missing-user' WHERE id='recovery-t'`, '23503'],
  ]) {
    await assert.rejects(target.query(sql), (error) => error.code === code);
  }
  assert.deepEqual(compareManifest(reference, await databaseManifest(target)), []);
  report.checks.writeRollbackAndConstraints = 'PASS';
  phase = 'negative-same-count-corruption';
  await target.query('BEGIN');
  await target.query(`UPDATE "Task" SET title='Corruption with unchanged count' WHERE id='recovery-t'`);
  const corrupted = await databaseManifest(target);
  assert.equal(corrupted['table:Task'].count, reference['table:Task'].count);
  assert.deepEqual(compareManifest(reference, corrupted), ['table:Task']);
  await target.query('ROLLBACK');
  report.checks.sameCountCorruptionRejected = 'PASS';
  phase = 'negative-schema-corruption';
  await target.query('BEGIN');
  await target.query('DROP INDEX "Section_one_done_per_project"');
  assert.deepEqual(compareManifest(reference, await databaseManifest(target)), ['schema:indexes']);
  await target.query('ROLLBACK');
  assert.deepEqual(compareManifest(reference, await databaseManifest(target)), []);
  report.checks.missingCustomIndexRejected = 'PASS';
  report.status = 'SYNTHETIC_REHEARSAL_PASS';
} catch (error) {
  // Do not serialize exception messages/SQL/connection objects into artifacts.
  report.failure = { phase, constraint: /^[A-Za-z0-9_]{1,100}$/.test(error.constraint ?? '') ? error.constraint : undefined, routine: /^[A-Za-z0-9_]{1,100}$/.test(error.routine ?? '') ? error.routine : undefined, code: /^[A-Z0-9_]{2,60}$/.test(error.code ?? '') ? error.code : 'CHECK_FAILED' };
  process.exitCode = 1;
} finally {
  try {
    for (const client of clients) if (client !== admin) await client.end();
    if (admin) {
      for (const database of owned) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      const remaining = await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [owned]);
      assert.equal(remaining.rowCount, 0);
    }
    report.cleanup = true;
  } catch {
    report.cleanup = false; report.status = 'FAIL'; report.cleanupFailure = 'OWNED_RESOURCE_CLEANUP_FAILED'; process.exitCode = 1;
  } finally {
    if (admin) await admin.end().catch(() => {});
    if (temp) rmSync(temp, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    writeFileSync(join(output, 'rehearsal.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, phase: report.failure?.phase, code: report.failure?.code, cleanup: report.cleanup, report: join(output, 'rehearsal.json') }));
  }
}
