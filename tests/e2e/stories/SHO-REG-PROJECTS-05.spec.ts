import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { account, PW } from '../local-api';
import { newDeal } from '../helpers/migration-2704';
import { newProject, newTask } from '../helpers/migration-2731';
import { expect, signInAs, zz } from './qa';

test('SHO-REG-PROJECTS-05 partial: deal-note visibility, removal and activity privacy', async ({ admin, later, browser }) => {
  if (!local2691) throw new Error('This notes/activity audit case uses only the guarded local test database.');
  const fixture = randomUUID();
  const evidenceDir = 'test-results/project-notes-activity';
  const ownedPeople: string[] = [], ownedProjects: string[] = [], ownedOrganisations: string[] = [], ownedNotes: string[] = [];
  later(async () => {
    for (const id of ownedPeople) {
      const result = await admin.api.get(`/api/team/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.person.status).toBe('DEACTIVATED');
    }
    for (const id of ownedProjects) {
      const result = await admin.api.get(`/api/projects/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.project.archived).toBe(true);
    }
    for (const id of ownedOrganisations) {
      const result = await admin.api.get(`/api/orgs/${id}`);
      expect(result.status).toBe(200);
      expect(result.json.organisation.archived).toBe(true);
      expect(result.json.organisation.notes.some((n: { id: string }) => ownedNotes.includes(n.id))).toBe(false);
    }
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, people: ownedPeople, projects: ownedProjects, organisations: ownedOrganisations, notes: ownedNotes, cleanup: true }, null, 2));
  });

  const people = await Promise.all(['editor', 'viewer', 'outsider'].map(async role => {
    const person = await account(zz(`notes ${role}`), `nakul17+zz-projects-05-${fixture}-${role}@aplyd.com`);
    ownedPeople.push(person.id);
    later(async () => {
      const result = await admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: 'leaders' });
      expect(result.status, JSON.stringify(result.json)).toBe(200);
    });
    return person;
  }));
  const [editor, viewer, outsider] = people;
  const sentinel = await newProject(admin, later, { label: 'notes sentinel' }); ownedProjects.push(sentinel.id);
  const sentinelBefore = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  const sentinelFingerprint = createHash('sha256').update(JSON.stringify(sentinelBefore)).digest('hex');
  const deal = await newDeal(admin, later, 'notes privacy'); ownedProjects.push(deal.id);
  const loaded = await admin.api.get(`/api/projects/${deal.id}`);
  expect(loaded.status).toBe(200);
  const orgId = loaded.json.project.deal.organisation.id as string;
  ownedOrganisations.push(orgId);
  for (const [person, role] of [[editor, 'EDITOR'], [viewer, 'VIEWER']] as const) {
    const result = await admin.api.post(`/api/projects/${deal.id}/members`, { userId: person.id, role });
    expect(result.status, JSON.stringify(result.json)).toBe(201);
  }
  const taskId = await newTask(admin, deal.id, { title: zz('private activity task'), assigneeId: editor.id });
  const privateText = zz('private <img src=x onerror=alert(1)> note');
  const publicText = zz('ordinary organisation note');
  async function create(text: string, date: string, projectId?: string) {
    const result = await admin.api.post(`/api/orgs/${orgId}/notes`, { kind: 'MEETING', date, text, projectId: projectId ?? null });
    expect(result.status, JSON.stringify(result.json)).toBe(201);
    const id = result.json.note.id as string;
    ownedNotes.push(id);
    later(async () => {
      const listed = await admin.api.get(`/api/orgs/${orgId}/notes`);
      if (listed.status === 200 && listed.json.notes.some((n: { id: string }) => n.id === id)) {
        expect((await admin.api.del(`/api/notes/${id}`)).status).toBe(204);
      }
    });
    return id;
  }
  const publicId = await create(publicText, '2026-11-05');
  const privateId = await create(privateText, '2026-11-06', deal.id);
  const notesFor = async (person: typeof editor) => (await person.c.get(`/api/orgs/${orgId}/notes`)).json.notes as { id: string; text: string }[];
  const adminNotes = (await admin.api.get(`/api/orgs/${orgId}/notes`)).json.notes as { id: string; text: string }[];
  const privateBefore = adminNotes.find(n => n.id === privateId);
  expect(privateBefore).toBeDefined();
  expect((await admin.api.patch(`/api/notes/${privateId}`, { text: 'unsupported edit' })).status).toBe(405);
  expect((await admin.api.put(`/api/notes/${privateId}`, { text: 'unsupported edit' })).status).toBe(405);
  const privateAfter = (await admin.api.get(`/api/orgs/${orgId}/notes`)).json.notes.find((n: { id: string }) => n.id === privateId);
  expect(privateAfter).toEqual(privateBefore);
  expect(adminNotes.map(n => n.id).slice(0, 2)).toEqual([privateId, publicId]);
  expect((await notesFor(editor)).map(n => n.id).slice(0, 2)).toEqual([privateId, publicId]);
  expect((await notesFor(viewer)).map(n => n.id).slice(0, 2)).toEqual([privateId, publicId]);
  expect((await notesFor(outsider)).map(n => n.id)).toEqual([publicId]);
  expect((await outsider.c.get(`/api/projects/${deal.id}/notes`)).status).toBe(404);
  expect((await editor.c.get(`/api/projects/${deal.id}/notes`)).json.notes.map((n: { id: string }) => n.id)).toEqual([privateId]);

  const adminActivity = await admin.api.get(`/api/projects/${deal.id}/activity`);
  expect(adminActivity.status).toBe(200);
  expect(adminActivity.json.items.length).toBeGreaterThan(0);
  expect(adminActivity.json.items.map((row: { ts: number }) => row.ts)).toEqual([...adminActivity.json.items.map((row: { ts: number }) => row.ts)].sort((a: number, b: number) => b - a));
  const editorActivity = await editor.c.get(`/api/projects/${deal.id}/activity`);
  expect(editorActivity.status).toBe(200);
  expect(editorActivity.json.items.length).toBeGreaterThan(0);
  expect(editorActivity.json.items.every((row: { what: string }) => row.what.includes(zz('private activity task')))).toBe(true);
  expect((await viewer.c.get(`/api/projects/${deal.id}/activity`)).status).toBe(403);
  expect((await outsider.c.get(`/api/projects/${deal.id}/activity`)).status).toBe(404);
  const orgHistory = await admin.api.get(`/api/orgs/${orgId}/history`);
  expect(orgHistory.status).toBe(200);
  expect(orgHistory.json.items.some((row: { action: string; targetId?: string }) => row.action === 'note.created')).toBe(true);
  expect((await editor.c.get(`/api/orgs/${orgId}/history`)).status).toBe(404);
  expect((await viewer.c.get(`/api/orgs/${orgId}/history`)).status).toBe(404);

  const page = admin.page;
  await page.goto(`/accounts/${orgId}?tab=notes`);
  await expect(page.getByText(privateText, { exact: true })).toBeVisible();
  await expect(page.locator('.org-notes-feed img')).toHaveCount(0);
  await expect(page.locator('.org-notes-feed').getByRole('button', { name: /^Edit/ })).toHaveCount(0);
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/plain-text-note.png`, fullPage: true });
  const viewerWho = await signInAs(browser, viewer.email, PW);
  try {
    await viewerWho.page.goto(`/projects/${deal.id}`);
    await expect(viewerWho.page.locator('.project-secondary-actions').getByRole('link', { name: 'Activity', exact: true })).toHaveCount(0);
  } finally { await viewerWho.ctx.close(); }

  expect((await admin.api.del(`/api/notes/${privateId}`)).status).toBe(204);
  expect((await admin.api.get(`/api/projects/${deal.id}/notes`)).json.notes).toHaveLength(0);
  expect((await notesFor(editor)).map(n => n.id)).toEqual([publicId]);
  expect((await notesFor(viewer)).map(n => n.id)).toEqual([publicId]);
  await page.reload();
  await expect(page.getByText(privateText, { exact: true })).toHaveCount(0);
  const postDeleteHistory = await admin.api.get(`/api/orgs/${orgId}/history`);
  expect(postDeleteHistory.json.items.some((row: { action: string }) => row.action === 'note.removed')).toBe(true);
  const removedViewer = await admin.api.del(`/api/projects/${deal.id}/members/${viewer.id}?handoverTo=${admin.user.id}`);
  expect(removedViewer.status, JSON.stringify(removedViewer.json)).toBe(204);
  expect((await viewer.c.get(`/api/projects/${deal.id}/notes`)).status).toBe(404);
  expect((await notesFor(viewer)).map(n => n.id)).toEqual([publicId]);
  const sentinelAfter = (await admin.api.get(`/api/projects/${sentinel.id}`)).json.project;
  expect(createHash('sha256').update(JSON.stringify(sentinelAfter)).digest('hex')).toBe(sentinelFingerprint);
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, dealId: deal.id, orgId, taskId, privateId, publicId, roleVisibility: { editor: true, viewer: true, outsider: false, removedViewer: false }, adminChronology: true, editorTaskScope: true, viewerActivityDenied: true, outsiderActivityHidden: true, adminOnlyOrgHistory: true, plainTextEscaped: true, unsupportedEditRejected: true, deletedNoteHidden: true, sentinelFingerprint, sentinelPreserved: true }, null, 2));
});
