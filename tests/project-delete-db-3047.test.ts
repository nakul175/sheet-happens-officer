import { expect, it } from "vitest";
import { db } from "@/lib/db";
import { project, superAdmin, task } from "./helpers";

it("SHO-3047 real delete/restore preserves linked work, hides active views, and audits both actions", async () => {
  const owner = await superAdmin();
  const name = `ZZ-TEST recoverable project ${Date.now()}`;
  const p = await project(owner, owner, [], name);
  const taskId = await task(owner, p.id);
  const before = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  const members = await db.projectMember.findMany({ where: { projectId: p.id } });
  const sections = await db.section.findMany({ where: { projectId: p.id } });
  try {
    expect((await owner.c.post(`/api/projects/${p.id}/delete`, { confirmationName: "wrong" })).status).toBe(400);
    expect((await owner.c.get(`/api/projects/${p.id}`)).status).toBe(200);
    expect((await owner.c.post(`/api/projects/${p.id}/delete`, { confirmationName: name })).status).toBe(200);
    expect((await owner.c.get(`/api/projects/${p.id}`)).status).toBe(404);
    expect((await owner.c.get(`/api/tasks/${taskId}`)).status).toBe(404);
    for (const query of ["", "?archived=true"]) {
      expect((await owner.c.get(`/api/projects${query}`)).json.projects.some((x: { id: string }) => x.id === p.id)).toBe(false);
    }
    expect((await owner.c.get("/api/projects?deleted=true")).json.projects.some((x: { id: string }) => x.id === p.id)).toBe(true);
    expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toEqual(before);
    expect(await db.projectMember.findMany({ where: { projectId: p.id } })).toEqual(members);
    expect(await db.section.findMany({ where: { projectId: p.id } })).toEqual(sections);
    expect((await owner.c.post(`/api/projects/${p.id}/restore`)).status).toBe(200);
    expect((await owner.c.get(`/api/tasks/${taskId}`)).status).toBe(200);
    expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).archivedAt).toBeNull();
    const actions = await db.actionLog.findMany({ where: { projectId: p.id, action: { in: ["project.deleted", "project.restored"] } } });
    expect(actions.map(a => a.action).sort()).toEqual(["project.deleted", "project.restored"]);
    expect(await db.auditLog.count({ where: { targetId: p.id, event: { in: ["PROJECT_DELETED", "PROJECT_RESTORED"] } } })).toBe(2);
    expect((await owner.c.post(`/api/projects/${p.id}/archive`)).status).toBe(200);
    const archivedAt = (await db.project.findUniqueOrThrow({ where: { id: p.id } })).archivedAt;
    expect((await owner.c.post(`/api/projects/${p.id}/delete`, { confirmationName: name })).status).toBe(200);
    expect((await owner.c.post(`/api/projects/${p.id}/restore`)).status).toBe(200);
    expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).archivedAt).toEqual(archivedAt);
  } finally {
    const current = await db.project.findUniqueOrThrow({ where: { id: p.id } });
    if (current.deletedAt) expect((await owner.c.post(`/api/projects/${p.id}/restore`)).status).toBe(200);
    if (!current.archivedAt) expect((await owner.c.post(`/api/projects/${p.id}/archive`)).status).toBe(200);
  }
});
