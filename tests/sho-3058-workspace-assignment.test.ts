// SHO-3058: a Leader/Admin can explicitly add an eligible workspace person while assigning or collaborating.
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { account, project, task } from "./helpers";

const db = new PrismaClient();

async function shown(who: Awaited<ReturnType<typeof account>>, taskId: string) {
  return (await who.c.get(`/api/tasks/${taskId}`)).json.task;
}

describe("SHO-3058 add workspace people during task assignment", () => {
  it("searches active verified same-workspace people by name/email and shows membership status", async () => {
    const lead = await account("3058-search-lead");
    const outsider = await account("3058-search-target", undefined, "ZZ 3058 Duplicate Name");
    const member = await account("3058-search-member", undefined, "ZZ 3058 Duplicate Name");
    const p = await project(lead, lead, [{ who: member, role: "VIEWER" }]);
    const seed = await db.user.findUniqueOrThrow({ where: { id: lead.id }, select: { workspaceId: true, passwordHash: true } });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const otherWorkspace = await db.workspace.create({ data: { name: `ZZ 3058 other ${stamp}` } });
    const cross = await db.user.create({ data: { workspaceId: otherWorkspace.id, name: "ZZ 3058 Duplicate Name", email: `zz-3058-cross-${stamp}@aplyd.com`, passwordHash: seed.passwordHash, emailVerifiedAt: new Date() } });
    const unverified = await db.user.create({ data: { workspaceId: seed.workspaceId, name: "ZZ 3058 Duplicate Name", email: `zz-3058-unverified-${stamp}@aplyd.com`, passwordHash: seed.passwordHash } });
    const deactivated = await db.user.create({ data: { workspaceId: seed.workspaceId, name: "ZZ 3058 Duplicate Name", email: `zz-3058-deactivated-${stamp}@aplyd.com`, passwordHash: seed.passwordHash, emailVerifiedAt: new Date(), deactivatedAt: new Date() } });

    const byName = await lead.c.get(`/api/projects/${p.id}/people?q=${encodeURIComponent("ZZ 3058 Duplicate")}`);
    expect(byName.status).toBe(200);
    expect(byName.json.canAdd).toBe(true);
    expect(byName.json.people).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: outsider.id, email: outsider.email, memberRole: null }),
      expect.objectContaining({ id: member.id, email: member.email, memberRole: "VIEWER" }),
    ]));
    expect(byName.json.people.map((x: { id: string }) => x.id).sort()).not.toEqual(expect.arrayContaining([cross.id, unverified.id, deactivated.id]));
    const byEmail = await lead.c.get(`/api/projects/${p.id}/people?q=${encodeURIComponent(outsider.email.slice(0, 18))}`);
    expect(byEmail.json.people.map((x: { id: string }) => x.id)).toContain(outsider.id);
    expect((await member.c.get(`/api/projects/${p.id}/people?q=ZZ`)).status).toBe(403);
  });

  it("atomically adds an Editor and assigns the task, with one membership notification and both audit receipts", async () => {
    const lead = await account("3058-assign-lead");
    const target = await account("3058-assign-target");
    const p = await project(lead, lead);
    const taskId = await task(lead, p.id);
    const before = await shown(lead, taskId);

    const added = await lead.c.post(`/api/tasks/${taskId}/assign`, {
      assigneeId: target.id,
      expectedUpdatedAt: before.updatedAt,
      addMemberRole: "EDITOR",
    });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    expect((await shown(lead, taskId)).assignee.id).toBe(target.id);
    expect(await db.projectMember.findUnique({ where: { projectId_userId: { projectId: p.id, userId: target.id } } })).toMatchObject({ role: "EDITOR" });
    expect(await db.notification.count({ where: { recipientId: target.id, type: "ADDED_TO_PROJECT", projectId: p.id } })).toBe(1);
    expect(await db.actionLog.count({ where: { actorId: lead.id, projectId: p.id, targetId: target.id, action: "member.added" } })).toBe(1);
    expect(await db.actionLog.count({ where: { actorId: lead.id, projectId: p.id, targetId: taskId, action: "task.assigned" } })).toBe(1);

    const current = await shown(lead, taskId);
    const repeated = await lead.c.post(`/api/tasks/${taskId}/assign`, {
      assigneeId: target.id,
      expectedUpdatedAt: current.updatedAt,
      addMemberRole: "EDITOR",
    });
    expect(repeated.status).toBe(200);
    expect(await db.notification.count({ where: { recipientId: target.id, type: "ADDED_TO_PROJECT", projectId: p.id } })).toBe(1);
    expect(await db.actionLog.count({ where: { actorId: lead.id, projectId: p.id, targetId: taskId, action: "task.assigned" } })).toBe(1);
  });

  it("adds a Viewer as collaborator, but an Editor cannot grant membership", async () => {
    const lead = await account("3058-collab-lead");
    const editor = await account("3058-collab-editor");
    const target = await account("3058-collab-target");
    const denied = await account("3058-collab-denied");
    const p = await project(lead, lead, [{ who: editor }]);
    const taskId = await task(lead, p.id);

    const forbidden = await editor.c.post(`/api/tasks/${taskId}/collaborators`, { userId: denied.id, addMemberRole: "VIEWER" });
    expect(forbidden.status).toBe(403);
    expect(await db.projectMember.findUnique({ where: { projectId_userId: { projectId: p.id, userId: denied.id } } })).toBeNull();

    const added = await lead.c.post(`/api/tasks/${taskId}/collaborators`, { userId: target.id, addMemberRole: "VIEWER" });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
    expect(await db.projectMember.findUnique({ where: { projectId_userId: { projectId: p.id, userId: target.id } } })).toMatchObject({ role: "VIEWER" });
    expect((await shown(lead, taskId)).collaborators.map((x: { id: string }) => x.id)).toContain(target.id);
  });

  it("leaves no membership or notices when the task association fails", async () => {
    const lead = await account("3058-rollback-lead");
    const target = await account("3058-rollback-target");
    const p = await project(lead, lead);
    const taskId = await task(lead, p.id);
    const stale = (await shown(lead, taskId)).updatedAt;
    await lead.c.patch(`/api/tasks/${taskId}`, { title: "Changed first", expectedUpdatedAt: stale });
    const failed = await lead.c.post(`/api/tasks/${taskId}/assign`, {
      assigneeId: target.id,
      expectedUpdatedAt: stale,
      addMemberRole: "EDITOR",
    });
    expect(failed.status).toBe(409);
    expect(await db.projectMember.findUnique({ where: { projectId_userId: { projectId: p.id, userId: target.id } } })).toBeNull();
    expect(await db.notification.count({ where: { recipientId: target.id, type: "ADDED_TO_PROJECT", projectId: p.id } })).toBe(0);
    expect(await db.actionLog.count({ where: { actorId: lead.id, projectId: p.id, targetId: target.id, action: "member.added" } })).toBe(0);
  });
});
