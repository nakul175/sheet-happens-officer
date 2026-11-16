import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { BASE, PW, task, withVersion, zzTestData } from '../local-api';
import { expect } from './qa';

const day = (offset: number) => new Date(Date.now() + 5.5 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);

test('SHO-REG-HOME-01 partial: Home cards and My tasks reconcile for owned work', async ({ browser, later }) => {
  if (!local2691) throw new Error('This Home audit case uses only the guarded local test database.');
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) ||
      !/^\/sho_test(?:_[\w-]+)?$/.test(database.pathname) || process.env.TASKBOARD_URL !== BASE)
    throw new Error('Use one loopback app and synthetic sho_test database for Home audit fixtures.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/home-reconciliation';
  const data = zzTestData(`home-${fixture}`);
  const ownedTasks: string[] = [];
  let ownedProject = '';
  let archivedProjectId = '';
  let actorId = '';
  const actor = await data.person('Home Leader'); actorId = actor.id;
  later(async () => {
    if (archivedProjectId) {
      const restored = await actor.c.post(`/api/projects/${archivedProjectId}/unarchive`, {});
      expect(restored.status, JSON.stringify(restored.json)).toBe(200);
    }
    for (const id of ownedTasks) {
      const removed = await actor.c.del(`/api/tasks/${id}`);
      expect([204, 404], JSON.stringify(removed.json)).toContain(removed.status);
      expect((await actor.c.get(`/api/tasks/${id}`)).status).toBe(404);
    }
    const problems = await data.cleanUp();
    expect(problems).toEqual([]);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, actorId, ownedProject, ownedTasks, cleanup: true }, null, 2));
  });

  const project = await data.project(actor); ownedProject = project.id;
  const created = async (label: string, dueDate: string) => {
    const id = await task(actor, project.id, { title: `ZZ-TEST ${label} ${fixture}`, assigneeId: actor.id, dueDate });
    ownedTasks.push(id);
    return id;
  };
  const overdue = await created('overdue', day(-1));
  const today = await created('today', day(0));
  const laterTask = await created('later', day(3));
  const completed = await created('completed', day(0));
  const closed = await actor.c.post(`/api/tasks/${completed}/complete`, await withVersion(actor, completed));
  expect(closed.status, JSON.stringify(closed.json)).toBe(200);

  const cards = await actor.c.get('/api/dashboard?panel=tasks');
  expect(cards.status).toBe(200);
  expect(cards.json).toMatchObject({ open: 3, overdue: 1, awaiting: 0 });
  expect(cards.json.priorities.map((row: { id: string }) => row.id)).toEqual([overdue, today, laterTask]);
  const projects = await actor.c.get('/api/dashboard?panel=projects');
  expect(projects.status).toBe(200);
  expect(projects.json).toMatchObject({ total: 1, items: [{ id: project.id, total: 4, completed: 1, percent: 25 }] });
  const my = await actor.c.get('/api/my-tasks');
  expect(my.status).toBe(200);
  const myIds = [...my.json.waitingOnMe, ...my.json.overdue, ...my.json.next7, ...my.json.later].map((row: { id: string }) => row.id);
  expect(myIds.sort()).toEqual([overdue, today, laterTask].sort());
  expect(myIds).not.toContain(completed);

  const context = await browser.newContext({ baseURL: BASE });
  try {
    const signin = await context.request.post('/api/auth/signin', { data: { email: actor.email, password: PW } });
    expect(signin.status()).toBe(200);
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your workspace' })).toBeVisible();
    const summary = page.getByLabel('Your work summary');
    await expect(summary.getByRole('link', { name: /Open tasks/ }).locator('strong')).toHaveText('3');
    await expect(summary.getByRole('link', { name: /Overdue/ }).locator('strong')).toHaveText('1');
    await expect(summary.getByRole('link', { name: /Awaiting your approval/ }).locator('strong')).toHaveText('0');
    await expect(summary.getByRole('link', { name: /Active projects/ }).locator('strong')).toHaveText('1');
    const priorities = page.getByRole('region', { name: 'Your priorities' });
    for (const id of [overdue, today, laterTask]) await expect(priorities.locator(`a[href="/tasks/${id}"]`)).toBeVisible();
    await expect(priorities.locator(`a[href="/tasks/${completed}"]`)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Your projects' }).getByText('1 of 4 tasks done')).toBeVisible();
    mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({ path: `${evidenceDir}/home-owned.png`, fullPage: true });
    await summary.getByRole('link', { name: /Open tasks/ }).click();
    await expect(page).toHaveURL(/\/my-tasks$/);
    const myTasksView = page.locator('.my-tasks-view');
    await expect(myTasksView.getByRole('heading', { name: 'My tasks' })).toBeVisible();
    for (const label of ['overdue', 'today', 'later'])
      await expect(myTasksView.getByText(`ZZ-TEST ${label} ${fixture}`, { exact: true })).toBeVisible();
    await expect(myTasksView.getByText(`ZZ-TEST completed ${fixture}`, { exact: true })).toHaveCount(0);
    // HOME-02: the Home overdue link is a URL filter; grouping is a per-user saved choice.
    await page.getByRole('button', { name: 'By project' }).click();
    await expect(page.getByRole('button', { name: 'By project' })).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.getByRole('button', { name: 'By project' })).toHaveAttribute('aria-pressed', 'true');
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Your workspace' })).toBeVisible();
    await summary.getByRole('link', { name: /Overdue/ }).click();
    await expect(page).toHaveURL(/\/my-tasks\?filter=overdue$/);
    await expect(myTasksView.getByText(`ZZ-TEST overdue ${fixture}`, { exact: true })).toBeVisible();
    for (const label of ['today', 'later', 'completed'])
      await expect(myTasksView.getByText(`ZZ-TEST ${label} ${fixture}`, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'By project' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('link', { name: 'Show all My tasks' }).click();
    await expect(page).toHaveURL(/\/my-tasks$/);
    for (const label of ['overdue', 'today', 'later'])
      await expect(myTasksView.getByText(`ZZ-TEST ${label} ${fixture}`, { exact: true })).toBeVisible();
    await page.goto(`/tasks/${today}`);
    await expect(page).toHaveURL(new RegExp(`/tasks/${today}$`));
    await page.goBack();
    await expect(page).toHaveURL(/\/my-tasks$/);
    await expect(page.getByRole('button', { name: 'By project' })).toHaveAttribute('aria-pressed', 'true');
    await page.goBack();
    await expect(page).toHaveURL(/\/my-tasks\?filter=overdue$/);
    await expect(myTasksView.getByText(`ZZ-TEST overdue ${fixture}`, { exact: true })).toBeVisible();
    await expect(myTasksView.getByText(`ZZ-TEST today ${fixture}`, { exact: true })).toHaveCount(0);
    const closeToday = await actor.c.post(`/api/tasks/${today}/complete`, await withVersion(actor, today));
    expect(closeToday.status, JSON.stringify(closeToday.json)).toBe(200);
    const refreshedCards = await actor.c.get('/api/dashboard?panel=tasks');
    expect(refreshedCards.status).toBe(200);
    expect(refreshedCards.json).toMatchObject({ open: 2, overdue: 1, awaiting: 0 });
    expect(refreshedCards.json.priorities.map((row: { id: string }) => row.id)).toEqual([overdue, laterTask]);
    const refreshedProjects = await actor.c.get('/api/dashboard?panel=projects');
    expect(refreshedProjects.status).toBe(200);
    expect(refreshedProjects.json).toMatchObject({ items: [{ id: project.id, total: 4, completed: 2, percent: 50 }] });
    await page.goto('/');
    await expect(summary.getByRole('link', { name: /Open tasks/ }).locator('strong')).toHaveText('2');
    await expect(priorities.locator(`a[href="/tasks/${today}"]`)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Your projects' }).getByText('2 of 4 tasks done')).toBeVisible();
    await summary.getByRole('link', { name: /Open tasks/ }).click();
    await expect(myTasksView.getByText(`ZZ-TEST today ${fixture}`, { exact: true })).toHaveCount(0);
    for (const label of ['overdue', 'later'])
      await expect(myTasksView.getByText(`ZZ-TEST ${label} ${fixture}`, { exact: true })).toBeVisible();
    const worker = await data.person('Home Worker');
    const joined = await actor.c.post(`/api/projects/${project.id}/members`, { userId: worker.id, role: 'EDITOR' });
    expect(joined.status, JSON.stringify(joined.json)).toBe(201);
    const awaitingTask = await task(worker, project.id, {
      title: `ZZ-TEST awaiting ${fixture}`, assigneeId: worker.id, approverId: actor.id, dueDate: day(2),
    });
    ownedTasks.push(awaitingTask);
    const sent = await worker.c.post(`/api/tasks/${awaitingTask}/send-for-approval`);
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    const approvalCards = await actor.c.get('/api/dashboard?panel=tasks');
    expect(approvalCards.status).toBe(200);
    expect(approvalCards.json).toMatchObject({ open: 3, overdue: 1, awaiting: 1 });
    const approvalMyTasks = await actor.c.get('/api/my-tasks');
    expect(approvalMyTasks.status).toBe(200);
    expect(approvalMyTasks.json.waitingOnMe.map((row: { id: string }) => row.id)).toContain(awaitingTask);
    await page.goto('/');
    await expect(summary.getByRole('link', { name: /Awaiting your approval/ }).locator('strong')).toHaveText('1');
    await expect(summary.getByRole('link', { name: /Open tasks/ }).locator('strong')).toHaveText('3');
    const stranger = await data.person('Hidden Leader');
    const hiddenProject = await data.project(stranger);
    const hiddenTitle = `ZZ-TEST private ${fixture}`;
    const hiddenTask = await task(stranger, hiddenProject.id, { title: hiddenTitle, assigneeId: stranger.id, dueDate: day(1) });
    const hiddenBefore = await stranger.c.get(`/api/tasks/${hiddenTask}`);
    expect(hiddenBefore.status).toBe(200);
    const isolatedCards = await actor.c.get('/api/dashboard?panel=tasks');
    expect(isolatedCards.status).toBe(200);
    expect(isolatedCards.json).toMatchObject({ open: 3, overdue: 1, awaiting: 1 });
    const isolatedProjects = await actor.c.get('/api/dashboard?panel=projects');
    expect(isolatedProjects.status).toBe(200);
    expect(isolatedProjects.json.total).toBe(1);
    const isolatedMyTasks = await actor.c.get('/api/my-tasks');
    expect(isolatedMyTasks.status).toBe(200);
    expect([...isolatedMyTasks.json.waitingOnMe, ...isolatedMyTasks.json.overdue, ...isolatedMyTasks.json.next7, ...isolatedMyTasks.json.later].map((row: { id: string }) => row.id)).not.toContain(hiddenTask);
    await page.reload();
    await expect(summary.getByRole('link', { name: /Open tasks/ }).locator('strong')).toHaveText('3');
    await expect(page.getByText(hiddenTitle, { exact: true })).toHaveCount(0);
    const hiddenAfter = await stranger.c.get(`/api/tasks/${hiddenTask}`);
    expect(hiddenAfter.status).toBe(200);
    expect(hiddenAfter.json).toEqual(hiddenBefore.json);
    const archivedProject = await data.project(actor);
    const archivedTitle = `ZZ-TEST archived ${fixture}`;
    const archivedTask = await task(actor, archivedProject.id, {
      title: archivedTitle, assigneeId: actor.id, dueDate: day(1),
    });
    ownedTasks.push(archivedTask);
    const archivedBefore = await actor.c.get(`/api/tasks/${archivedTask}`);
    expect(archivedBefore.status).toBe(200);
    const archive = await actor.c.post(`/api/projects/${archivedProject.id}/archive`, {});
    expect(archive.status, JSON.stringify(archive.json)).toBe(200);
    archivedProjectId = archivedProject.id;
    const afterArchiveCards = await actor.c.get('/api/dashboard?panel=tasks');
    expect(afterArchiveCards.status).toBe(200);
    expect(afterArchiveCards.json).toMatchObject({ open: 3, overdue: 1, awaiting: 1 });
    expect(afterArchiveCards.json.priorities.map((row: { id: string }) => row.id)).not.toContain(archivedTask);
    const afterArchiveProjects = await actor.c.get('/api/dashboard?panel=projects');
    expect(afterArchiveProjects.status).toBe(200);
    expect(afterArchiveProjects.json.total).toBe(1);
    expect(afterArchiveProjects.json.items.map((row: { id: string }) => row.id)).not.toContain(archivedProject.id);
    const afterArchiveMyTasks = await actor.c.get('/api/my-tasks');
    expect(afterArchiveMyTasks.status).toBe(200);
    expect([...afterArchiveMyTasks.json.waitingOnMe, ...afterArchiveMyTasks.json.overdue,
      ...afterArchiveMyTasks.json.next7, ...afterArchiveMyTasks.json.later]
      .map((row: { id: string }) => row.id)).not.toContain(archivedTask);
    await page.reload();
    await expect(summary.getByRole('link', { name: /Open tasks/ }).locator('strong')).toHaveText('3');
    await expect(page.getByText(archivedTitle, { exact: true })).toHaveCount(0);
    const archivedAfter = await actor.c.get(`/api/projects/${archivedProject.id}`);
    expect(archivedAfter.status).toBe(200);
    expect(archivedAfter.json.project.archived).toBe(true);
    const sharedTask = await task(worker, project.id, {
      title: `ZZ-TEST shared ${fixture}`, assigneeId: worker.id, dueDate: day(4),
    });
    ownedTasks.push(sharedTask);
    const shared = await worker.c.post(`/api/tasks/${sharedTask}/collaborators`, { userId: actor.id });
    expect(shared.status, JSON.stringify(shared.json)).toBe(201);
    const withShared = await actor.c.get('/api/dashboard?panel=tasks');
    expect(withShared.status).toBe(200);
    expect(withShared.json).toMatchObject({ open: 4, overdue: 1, awaiting: 1 });
    expect(withShared.json.priorities.map((row: { id: string }) => row.id)).toContain(sharedTask);
    const sharedMyTasks = await actor.c.get('/api/my-tasks');
    expect(sharedMyTasks.status).toBe(200);
    expect([...sharedMyTasks.json.waitingOnMe, ...sharedMyTasks.json.overdue,
      ...sharedMyTasks.json.next7, ...sharedMyTasks.json.later]
      .map((row: { id: string }) => row.id)).toContain(sharedTask);
    await page.reload();
    await expect(summary.getByRole('link', { name: /Open tasks/ }).locator('strong')).toHaveText('4');
    await expect(priorities.locator(`a[href="/tasks/${sharedTask}"]`)).toBeVisible();
    const unshared = await worker.c.del(`/api/tasks/${sharedTask}/collaborators/${actor.id}`);
    expect(unshared.status, JSON.stringify(unshared.json)).toBe(204);
    const afterUnshare = await actor.c.get('/api/dashboard?panel=tasks');
    expect(afterUnshare.status).toBe(200);
    expect(afterUnshare.json).toMatchObject({ open: 3, overdue: 1, awaiting: 1 });
    const afterUnshareMyTasks = await actor.c.get('/api/my-tasks');
    expect(afterUnshareMyTasks.status).toBe(200);
    expect([...afterUnshareMyTasks.json.waitingOnMe, ...afterUnshareMyTasks.json.overdue,
      ...afterUnshareMyTasks.json.next7, ...afterUnshareMyTasks.json.later]
      .map((row: { id: string }) => row.id)).not.toContain(sharedTask);
    await page.reload();
    await expect(summary.getByRole('link', { name: /Open tasks/ }).locator('strong')).toHaveText('3');
    await expect(priorities.locator(`a[href="/tasks/${sharedTask}"]`)).toHaveCount(0);
    const emptyUser = await data.person('Empty Member');
    const emptyContext = await browser.newContext({ baseURL: BASE });
    try {
      const emptySignin = await emptyContext.request.post('/api/auth/signin', { data: { email: emptyUser.email, password: PW } });
      expect(emptySignin.status()).toBe(200);
      const emptyPage = await emptyContext.newPage();
      const tasksRoute = (url: URL) => url.pathname === '/api/dashboard' && url.searchParams.get('panel') === 'tasks';
      await emptyPage.route(tasksRoute, async route => {
        await new Promise(resolve => setTimeout(resolve, 1_500));
        await route.continue();
      });
      await emptyPage.goto('/', { waitUntil: 'domcontentloaded' });
      const emptyPriorities = emptyPage.getByRole('region', { name: 'Your priorities' });
      await expect(emptyPriorities.locator('.skel-row').first()).toBeVisible();
      await expect(emptyPage.getByLabel('Your work summary').getByRole('link', { name: /Open tasks/ }).locator('strong')).toHaveText('0');
      await emptyPage.unroute(tasksRoute);
      await emptyPage.route(tasksRoute, async route =>
        route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic unavailable' }) }));
      await emptyPage.reload();
      await expect(emptyPriorities.getByRole('alert').getByText('Could not reach the server.')).toBeVisible();
      await emptyPage.unroute(tasksRoute);
      await emptyPriorities.getByRole('button', { name: 'Retry' }).click();
      await expect(emptyPage.getByLabel('Your work summary').getByRole('link', { name: /Open tasks/ }).locator('strong')).toHaveText('0');
      await expect(emptyPriorities.getByText('No open work assigned to you or shared with you.')).toBeVisible();
      await expect(emptyPage.getByRole('region', { name: 'Your projects' }).getByText('You have no active membership projects.')).toBeVisible();
      await expect(emptyPage.getByText(hiddenTitle, { exact: true })).toHaveCount(0);
    } finally { await emptyContext.close(); }
    writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, actorId, ownedProject, ownedTasks, initial: { open: 3, overdue: 1, awaiting: 0, completed: 1 }, afterCloseAndRefresh: { open: 2, overdue: 1, awaiting: 0, completed: 2 }, afterApprovalSend: { open: 3, overdue: 1, awaiting: 1, waitingOnMe: awaitingTask }, unrelatedHiddenTask: hiddenTask, unrelatedSentinelUnchanged: true, archivedProject: archivedProject.id, archivedTask, archivedWorkExcluded: true, sharedTask, collaboratorAddRemoveReconciled: true, emptyUserLoadingErrorRetryAndZeroState: true, projects: 1, topLevel: 5, initialMyTaskIds: myIds, homeAndMyTasksAgree: true }, null, 2));
  } finally { await context.close(); }
});
