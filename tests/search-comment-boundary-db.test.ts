// Real PostgreSQL search regression on the disposable local CI database only.
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { account, cleanupZz, project, superAdmin, task } from './helpers';
import { actor, db } from './actor';
import { search } from '@/lib/search';

afterEach(() => vi.unstubAllEnvs());

it('comment search keeps flag, idea, archive, membership and Trash boundaries together', async () => {
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.pathname !== '/sho_test') {
    throw Error('LOCAL_DISPOSABLE_SHO_TEST_REQUIRED');
  }
  vi.stubEnv('SEARCH_STAGE_A_ENABLED', 'false');
  const phrase = `zzcommentsearch${randomUUID().replaceAll('-', '')}`;
  const root = await superAdmin();
  const member = await account('search-comment-member');
  const outsider = await account('search-comment-outsider');
  const projects: string[] = [];
  const commentIds: string[] = [];
  let ownArchived = false;
  try {
    const own = await project(root, root, [{ who: member, role: 'VIEWER' }], `ZZ-TEST comment search own ${phrase}`);
    projects.push(own.id);
    const foreign = await project(root, root, [], `ZZ-TEST comment search foreign ${phrase}`);
    projects.push(foreign.id);
    const ownIdea = await task(root, own.id, { title: 'ZZ-TEST neutral idea' });
    const ownOrdinary = await task(root, own.id, { title: 'ZZ-TEST neutral ordinary' });
    const foreignTask = await task(root, foreign.id, { title: 'ZZ-TEST neutral foreign' });
    const trashedTask = await task(root, own.id, { title: 'ZZ-TEST neutral trash' });
    await db.task.update({ where: { id: ownIdea }, data: { isIdea: true } });
    for (const taskId of [ownIdea, ownOrdinary, foreignTask, trashedTask]) {
      const row = await db.comment.create({ data: { taskId, authorId: root.id, text: `ZZ-TEST hidden body ${phrase}` } });
      commentIds.push(row.id);
    }
    expect((await root.c.del(`/api/tasks/${trashedTask}`)).status).toBe(204);

    const ids = async (archived: boolean, ideasOnly: boolean) => {
      const result = await search(actor(member), phrase, archived, ideasOnly);
      const body = JSON.stringify(result);
      expect(body).not.toContain('ZZ-TEST hidden body');
      expect(body).not.toContain(foreignTask);
      expect(body).not.toContain(trashedTask);
      return result.tasks.map(row => row.id).sort();
    };
    vi.stubEnv('FF_TASK_COMMENTS', 'false');
    expect(await ids(false, false)).toEqual([]);
    vi.stubEnv('FF_TASK_COMMENTS', 'true');
    expect(await ids(false, false)).toEqual([ownIdea, ownOrdinary].sort());
    expect(await ids(false, true)).toEqual([ownIdea]);
    expect((await search(actor(outsider), phrase, true)).tasks).toEqual([]);
    expect((await search(actor(root, 'SUPER_ADMIN'), phrase, false)).tasks.map(row => row.id)).toContain(foreignTask);

    expect((await root.c.post(`/api/projects/${own.id}/archive`)).status).toBe(200);
    ownArchived = true;
    expect(await ids(false, false)).toEqual([]);
    expect(await ids(true, false)).toEqual([ownIdea, ownOrdinary].sort());
    expect(await ids(true, true)).toEqual([ownIdea]);
    vi.stubEnv('FF_TASK_COMMENTS', 'false');
    expect(await ids(true, false)).toEqual([]);
  } finally {
    await db.comment.deleteMany({ where: { id: { in: commentIds } } });
    expect(await db.comment.count({ where: { id: { in: commentIds } } })).toBe(0);
    if (ownArchived && projects[0]) expect((await root.c.post(`/api/projects/${projects[0]}/unarchive`)).status).toBe(200);
    if (projects.length) await cleanupZz(projects, [member, outsider]);
  }
});
