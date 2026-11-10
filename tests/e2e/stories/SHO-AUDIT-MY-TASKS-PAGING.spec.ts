import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { BASE, PW, task, zzTestData } from '../local-api';
import { expect } from './qa';

const day = (offset: number) => new Date(Date.now() + 5.5 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);

test('audit My Tasks v2 pages exact own work, keeps legacy response and denies foreign cursors', async ({ browser, later }) => {
  if (!local2691) throw new Error('Use the guarded local test database for the My Tasks paging fixture.');
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) || !/^\/sho_test(?:_[\w-]+)?$/.test(database.pathname) || process.env.TASKBOARD_URL !== BASE)
    throw new Error('DISPOSABLE_LOOPBACK_FIXTURE_REQUIRED');
  const fixture = randomUUID();
  const dir = 'test-results/my-tasks-paging';
  const data = zzTestData(`my-tasks-paging-${fixture}`);
  const actor = await data.person('Paging Leader');
  const outsider = await data.person('Paging Outsider');
  const project = await data.project(actor);
  const foreign = await data.project(outsider);
  const ids: string[] = [];
  later(async () => {
    for (const id of ids) {
      const removed = await actor.c.del(`/api/tasks/${id}`);
      expect([204, 404]).toContain(removed.status);
      expect((await actor.c.get(`/api/tasks/${id}`)).status).toBe(404);
    }
    const errors = await data.cleanUp();
    expect(errors).toEqual([]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/cleanup.json`, JSON.stringify({ fixture, taskCount: ids.length, cleanup: true }, null, 2));
  });
  for (let index = 0; index < 26; index++) ids.push(await task(actor, project.id, { title: `ZZ-TEST paging ${fixture} ${index}`, dueDate: day(2), assigneeId: actor.id }));
  const overdue = await task(actor, project.id, { title: `ZZ-TEST paging overdue ${fixture}`, dueDate: day(-1), assigneeId: actor.id });
  ids.push(overdue);
  const foreignTask = await task(outsider, foreign.id, { title: `ZZ-TEST foreign paging ${fixture}`, dueDate: day(2), assigneeId: outsider.id });
  const first = await actor.c.get('/api/my-tasks?v=2');
  expect(first.status, JSON.stringify(first.json)).toBe(200);
  expect(first.json.version).toBe(2);
  expect(first.json.groups.next7).toMatchObject({ total: 26, hasMore: true });
  expect(first.json.groups.next7.items).toHaveLength(25);
  expect(first.json.groups.overdue).toMatchObject({ total: 1, hasMore: false });
  expect(first.json.groups.overdue.items.map((row: { id: string }) => row.id)).toEqual([overdue]);
  expect(JSON.stringify(first.json)).not.toContain(foreignTask);
  const bytes = Buffer.byteLength(JSON.stringify(first.json));
  expect(bytes).toBeLessThanOrEqual(512 * 1024);
  const cursor = first.json.groups.next7.nextCursor as string;
  expect(cursor).toBeTruthy();
  const second = await actor.c.get(`/api/my-tasks?v=2&group=next7&cursor=${encodeURIComponent(cursor)}`);
  expect(second.status, JSON.stringify(second.json)).toBe(200);
  expect(second.json.page).toMatchObject({ total: 26, hasMore: false, nextCursor: null });
  expect(second.json.page.items).toHaveLength(1);
  expect([...first.json.groups.next7.items, ...second.json.page.items].map((row: { id: string }) => row.id).sort()).toEqual(ids.filter(id => id !== overdue).sort());
  expect((await outsider.c.get(`/api/my-tasks?v=2&group=next7&cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
  expect((await actor.c.get(`/api/my-tasks?v=2&group=next7&cursor=${encodeURIComponent(cursor + 'x')}`)).status).toBe(400);
  expect((await actor.c.get('/api/my-tasks?v=2&limit=101')).status).toBe(400);
  const filtered = await actor.c.get('/api/my-tasks?v=2&filter=overdue');
  expect(filtered.status, JSON.stringify(filtered.json)).toBe(200);
  expect(filtered.json.groups.overdue.total).toBe(1);
  expect(filtered.json.groups.next7.total).toBe(0);
  const legacy = await actor.c.get('/api/my-tasks');
  expect(legacy.status, JSON.stringify(legacy.json)).toBe(200);
  expect(legacy.json.version).toBeUndefined();
  expect(legacy.json.next7).toHaveLength(26);

  const context = await browser.newContext({ baseURL: BASE });
  try {
    expect((await context.request.post('/api/auth/signin', { data: { email: actor.email, password: PW } })).status()).toBe(200);
    const page = await context.newPage();
    await page.goto('/my-tasks');
    await expect(page.getByText('Next 7 days · 26')).toBeVisible();
    await expect(page.locator('.my-tasks-view .item.click')).toHaveCount(26); // 25 next-week + one overdue
    await page.getByRole('button', { name: 'Load more next 7 days' }).click();
    await expect(page.locator('.my-tasks-view .item.click')).toHaveCount(27);
    await expect(page.getByText(`ZZ-TEST paging ${fixture} 25`)).toBeVisible();
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/loaded.png`, fullPage: true });
  } finally { await context.close(); }
  writeFileSync(`${dir}/verification.json`, JSON.stringify({ fixture, firstPage: 25, secondPage: 1, next7Total: 26, overdueTotal: 1, initialBytes: bytes, foreignHidden: true, cursorDenied: true, legacyPreserved: true, uiLoaded: 27 }, null, 2));
});
