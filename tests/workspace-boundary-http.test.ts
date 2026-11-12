// Real local PostgreSQL and HTTP check for the one-organisation-per-deployment contract.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { assertLocalFixture } from './e2e/local-fixture-guard';
import { BASE, Client } from './helpers';

it('fails closed across read surfaces when storage has two workspaces, then recovers after cleanup', async () => {
  assertLocalFixture(process.env.DATABASE_URL, BASE);
  const primary = await getOrCreateWorkspace();
  const id = 'zzscope' + randomUUID().replaceAll('-', '');
  const token = randomBytes(32).toString('hex');
  const client = new Client();
  client.cookie = 'sho_session=' + token;
  const before = await db.workspace.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  expect(before.map(row => row.id)).toEqual([primary.id]);
  try {
    await db.user.create({ data: { id, workspaceId: primary.id, name: 'ZZ-TEST boundary admin', email: `${id}@aplyd.com`, passwordHash: 'unused-synthetic-fixture', emailVerifiedAt: new Date(), orgRole: 'ADMIN' } });
    await db.session.create({ data: { userId: id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3600_000) } });
    expect((await client.get('/api/auth/me')).status).toBe(200);
    const foreign = await db.workspace.create({ data: { name: `ZZ-TEST ${id}` }, select: { id: true } });
    try {
      for (const path of ['/api/auth/me', '/api/projects', '/api/deals', '/api/team', '/api/orgs', '/api/search?q=ZZ-TEST']) {
        const response = await client.get(path);
        expect(response.status, path).toBe(503);
        expect(JSON.stringify(response.json), path).not.toContain(id);
      }
      expect((await db.workspace.findMany({ select: { id: true } })).length).toBe(2);
    } finally {
      await db.workspace.delete({ where: { id: foreign.id } });
    }
    expect((await client.get('/api/auth/me')).status).toBe(200);
    expect((await client.get('/api/projects')).status).toBe(200);
  } finally {
    await db.session.deleteMany({ where: { userId: id } });
    await db.user.deleteMany({ where: { id } });
    expect(await db.workspace.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).toEqual(before);
    expect(await db.user.count({ where: { id } })).toBe(0);
  }
});
