import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { newProject, newTask } from "../helpers/migration-2731";
import { local2691, test } from "../helpers/2691-admin";
import { expect, zz } from "./qa";

test("SHO-REG-TASKS-08 mixed bulk result undoes only its successful task", async ({ admin, later }) => {
  if (!local2691) throw new Error("Bulk audit case requires the guarded local test database.");
  const fixture = randomUUID();
  const ownedProjects: string[] = [];
  later(async () => {
    for (const id of ownedProjects) {
      const loaded = await admin.api.get(`/api/projects/${id}`);
      expect(loaded.status).toBe(200);
      expect(loaded.json.project.archived).toBe(true);
    }
    mkdirSync("test-results/bulk-mixed", { recursive: true });
    writeFileSync("test-results/bulk-mixed/cleanup.json", JSON.stringify({ fixture, ownedProjects, archived: true }, null, 2));
  });

  const target = await newProject(admin, later, { label: "bulk mixed target" }); ownedProjects.push(target.id);
  const foreignProject = await newProject(admin, later, { label: "bulk mixed foreign" }); ownedProjects.push(foreignProject.id);
  const archivedProject = await newProject(admin, later, { label: "bulk mixed archived" }); ownedProjects.push(archivedProject.id);
  const sentinelProject = await newProject(admin, later, { label: "bulk mixed sentinel" }); ownedProjects.push(sentinelProject.id);
  const good = await newTask(admin, target.id, { title: zz("bulk good") });
  const stale = await newTask(admin, target.id, { title: zz("bulk stale") });
  const foreign = await newTask(admin, foreignProject.id, { title: zz("bulk foreign") });
  const archived = await newTask(admin, archivedProject.id, { title: zz("bulk archived") });
  const sentinel = await newTask(admin, sentinelProject.id, { title: zz("bulk sentinel") });
  const loaded = await Promise.all([good, stale, foreign, archived].map(id => admin.api.get(`/api/tasks/${id}`)));
  for (const row of loaded) expect(row.status).toBe(200);
  const versions = Object.fromEntries([good, stale, foreign, archived].map((id, i) => [id, loaded[i].json.task.updatedAt]));
  const sentinelBefore = await admin.api.get(`/api/tasks/${sentinel}`);
  expect(sentinelBefore.status).toBe(200);
  const fingerprint = createHash("sha256").update(JSON.stringify(sentinelBefore.json.task)).digest("hex");

  const renamed = await admin.api.patch(`/api/tasks/${stale}`, { title: zz("changed after selection"), expectedUpdatedAt: versions[stale] });
  expect(renamed.status, JSON.stringify(renamed.json)).toBe(200);
  expect((await admin.api.post(`/api/projects/${archivedProject.id}/archive`)).status).toBe(200);

  const bulk = await admin.api.post(`/api/projects/${target.id}/tasks/bulk`, {
    taskIds: [good, stale, foreign, archived], action: "complete", versions,
  });
  expect(bulk.status, JSON.stringify(bulk.json)).toBe(200);
  expect(bulk.json.changed).toBe(1);
  expect(bulk.json.skipped).toEqual([
    { id: stale, title: zz("changed after selection"), reason: "changed by someone else" },
    { id: foreign, title: "A task", reason: "not found" },
    { id: archived, title: "A task", reason: "not found" },
  ]);
  expect(bulk.json.undoIds).toHaveLength(1);
  const state = async (id: string) => admin.api.get(`/api/tasks/${id}`);
  expect((await state(good)).json.task.completedAt).toBeTruthy();
  expect((await state(stale)).json.task.completedAt).toBeNull();
  expect((await state(foreign)).json.task.completedAt).toBeNull();
  expect((await admin.api.get(`/api/projects/${archivedProject.id}`)).json.project.archived).toBe(true);

  const undo = await admin.api.post("/api/actions/bulk-undo", { ids: bulk.json.undoIds });
  expect(undo.status, JSON.stringify(undo.json)).toBe(200);
  expect(undo.json.count).toBe(1);
  expect((await state(good)).json.task.completedAt).toBeNull();
  expect((await state(stale)).json.task.title).toBe(zz("changed after selection"));
  expect((await state(foreign)).json.task.completedAt).toBeNull();
  expect((await admin.api.post(`/api/projects/${archivedProject.id}/unarchive`)).status).toBe(200);
  expect((await state(archived)).json.task.completedAt).toBeNull();
  expect((await admin.api.post(`/api/projects/${archivedProject.id}/archive`)).status).toBe(200);
  const sentinelAfter = await state(sentinel);
  expect(createHash("sha256").update(JSON.stringify(sentinelAfter.json.task)).digest("hex")).toBe(fingerprint);
  mkdirSync("test-results/bulk-mixed", { recursive: true });
  writeFileSync("test-results/bulk-mixed/verification.json", JSON.stringify({ fixture, changed: bulk.json.changed, skipped: bulk.json.skipped.map((x: { reason: string }) => x.reason), undoCount: undo.json.count, sentinelUnchanged: true }, null, 2));
});
