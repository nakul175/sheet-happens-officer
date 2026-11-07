// A disposable PostgreSQL worker is killed after writing a run-owned project.
// The next run must see no residue, while an unrelated sentinel remains byte-for-byte unchanged.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { runCleanup } from './e2e/helpers/qa-cleanup';
import { assertLocalFixture } from './e2e/local-fixture-guard';

vi.mock('next/server', () => ({ connection: vi.fn() }));

const prefix = `zz-interrupt-${randomUUID()}`;
const sentinelName = `zz-sentinel-${randomUUID()}`;
const runs: { name: string; signal: string; ownedAfterCleanup: number; sentinelUnchanged: boolean }[] = [];
let workspaceId = '';
let sentinelId = '';
let safe = false;
let cleanup = false;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  sentinelId = (await db.project.create({ data: { workspaceId, name: sentinelName } })).id;
});

afterAll(async () => {
  if (!safe) return;
  try {
    await db.project.deleteMany({ where: { workspaceId, name: { in: [`${prefix}-1`, `${prefix}-2`] } } });
    if (sentinelId) await db.project.delete({ where: { id: sentinelId } });
    expect(await db.project.count({ where: { workspaceId, name: { in: [`${prefix}-1`, `${prefix}-2`, sentinelName] } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync('test-results/fixture-interruption', { recursive: true });
    writeFileSync('test-results/fixture-interruption/receipt.json', JSON.stringify({ prefix, runs, cleanup }, null, 2));
  }
});

it('cleans two interrupted run namespaces without changing an unrelated sentinel', async () => {
  const before = await db.project.findUniqueOrThrow({ where: { id: sentinelId } });
  for (const number of [1, 2]) {
    const name = `${prefix}-${number}`;
    expect(await db.project.count({ where: { workspaceId, name } })).toBe(0);
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/fixture-interruption-child.ts', workspaceId, name], {
      encoding: 'utf8', timeout: 15000, env: process.env,
    });
    expect(child.error).toBeUndefined();
    const childError = child.stderr.includes('DISPOSABLE_LOCAL_SHO_TEST_REQUIRED') ? 'GUARD' :
      child.stderr.includes('CHILD_CREATE_FAILED') ? 'CREATE' : child.stderr ? 'RUNTIME' : 'NONE';
    expect(child.signal, `child exit status ${child.status}; error category ${childError}`).toBe('SIGKILL');
    const line = child.stdout.trim();
    const id = (JSON.parse(line) as { id: string }).id;
    expect((await db.project.findUniqueOrThrow({ where: { id } })).name).toBe(name);
    await runCleanup([async () => {
      const result = await db.project.deleteMany({ where: { id, workspaceId, name } });
      expect(result.count).toBe(1);
    }]);
    const ownedAfterCleanup = await db.project.count({ where: { workspaceId, name } });
    expect(ownedAfterCleanup).toBe(0);
    const after = await db.project.findUniqueOrThrow({ where: { id: sentinelId } });
    const sentinelUnchanged = JSON.stringify(after) === JSON.stringify(before);
    expect(sentinelUnchanged).toBe(true);
    runs.push({ name, signal: child.signal!, ownedAfterCleanup, sentinelUnchanged });
  }
  expect(runs).toHaveLength(2);
});
