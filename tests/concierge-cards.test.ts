// @APL-2675: a concierge delete card offers Undo only to a Leader or an Admin (same rule as Trash restore).
// Seeds this file's own project and nakul17+apl2675-* people, then removes only those rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { undoView } from "../src/components/concierge/logic";
import type { Actor } from "../src/lib/access";
import { hashPassword } from "../src/lib/auth";
import { confirmCard, undoCard } from "../src/lib/concierge/cards";
import { buildCard, type Op } from "../src/lib/concierge/changes";
import { addMessage } from "../src/lib/concierge/thread";
import { db } from "../src/lib/db";
import { ApiError } from "../src/lib/http";
import { createProject } from "../src/lib/projects";
import { istDate } from "./helpers";
import { createTask } from "../src/lib/tasks";

const PROJECT = "ZZ-TEST APL-2675";
const EMAILS = {
  editor: "nakul17+apl2675-editor@gmail.com",
  leader: "nakul17+apl2675-leader@gmail.com",
  superAdmin: "nakul17+apl2675-super@gmail.com",
} as const;

const editor: Actor = { id: "", orgRole: "MEMBER", name: "Editor" };
const leader: Actor = { id: "", orgRole: "MEMBER", name: "Leader" };
const superAdmin: Actor = { id: "", orgRole: "SUPER_ADMIN", name: "Super Admin" };
let projectId = "";
let decoyProjectId = "";
let decoyUserId = "";

/** This file's project ids only: the one it created, plus any still owned by its nakul17+apl2675-* people. */
async function ownProjectIds(userIds: string[]) {
  const ids = new Set<string>();
  if (projectId) ids.add(projectId);
  if (userIds.length) {
    const memberships = await db.projectMember.findMany({ where: { userId: { in: userIds } }, select: { projectId: true } });
    for (const m of memberships) ids.add(m.projectId);
  }
  return [...ids];
}

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { in: Object.values(EMAILS) } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const pids = await ownProjectIds(ids);
  if (pids.length) {
    await db.notification.deleteMany({ where: { projectId: { in: pids } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: pids } } });
    await db.auditLog.deleteMany({ where: { targetId: { in: pids } } });
    await db.project.deleteMany({ where: { id: { in: pids } } });
  }
  if (ids.length) {
    await db.notification.deleteMany({ where: { OR: [{ recipientId: { in: ids } }, { actorId: { in: ids } }] } });
    await db.actionLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { undoneById: { in: ids } }] } });
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] } });
    await db.chatMessage.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

async function person(email: string, name: string, orgRole: Actor["orgRole"], workspaceId: string): Promise<Actor> {
  const user = await db.user.create({
    data: {
      workspaceId,
      email,
      name,
      passwordHash: await hashPassword("correct-horse-9"),
      emailVerifiedAt: new Date(),
      orgRole,
    },
  });
  return { id: user.id, orgRole, name };
}

/** A pending card, as the concierge would store it, ready to confirm. */
async function pendingCard(user: Actor, ops: Op[]) {
  const built = await buildCard(user, ops);
  const row = await addMessage(user, "ASSISTANT", {
    kind: "card",
    text: built.card.title,
    card: { id: "", status: "PENDING", ...built.card },
    proposal: { ops: built.ops, fingerprint: built.fingerprint, versions: built.versions },
  });
  return row.id;
}

async function taskT1() {
  return createTask(leader, projectId, { title: "T1", dueDate: istDate(1) });
}

describe("@APL-2675 Concierge delete card offers Undo only to people who may restore", () => {
  beforeAll(async () => {
    await cleanup();
    const workspace = (await db.workspace.findFirst({ orderBy: { createdAt: "asc" } }))
      ?? (await db.workspace.create({ data: { name: "Workspace" } }));
    Object.assign(editor, await person(EMAILS.editor, "Editor", "MEMBER", workspace.id));
    Object.assign(leader, await person(EMAILS.leader, "Leader", "MEMBER", workspace.id));
    Object.assign(superAdmin, await person(EMAILS.superAdmin, "Super Admin", "SUPER_ADMIN", workspace.id));
    projectId = (await createProject(leader, {
      name: PROJECT,
      leaderId: leader.id,
      members: [{ userId: editor.id, role: "EDITOR" }],
    })).id;
    // A different ZZ-TEST project must survive this file's cleanup.
    const decoyEmail = "nakul17+not-apl2675@gmail.com";
    const leftover = await db.user.findUnique({ where: { email: decoyEmail }, select: { id: true } });
    if (leftover) {
      const memberships = await db.projectMember.findMany({ where: { userId: leftover.id }, select: { projectId: true } });
      const leftoverIds = memberships.map((m) => m.projectId);
      if (leftoverIds.length) {
        await db.notification.deleteMany({ where: { projectId: { in: leftoverIds } } });
        await db.actionLog.deleteMany({ where: { projectId: { in: leftoverIds } } });
        await db.project.deleteMany({ where: { id: { in: leftoverIds } } });
      }
      await db.notification.deleteMany({ where: { OR: [{ recipientId: leftover.id }, { actorId: leftover.id }] } });
      await db.actionLog.deleteMany({ where: { OR: [{ actorId: leftover.id }, { undoneById: leftover.id }] } });
      await db.auditLog.deleteMany({ where: { OR: [{ actorId: leftover.id }, { targetId: leftover.id }] } });
      await db.user.delete({ where: { id: leftover.id } });
    }
    const decoy = await person(decoyEmail, "Decoy", "MEMBER", workspace.id);
    decoyUserId = decoy.id;
    decoyProjectId = (await createProject(decoy, { name: "ZZ-TEST leave-me", leaderId: decoy.id })).id;
  });

  afterAll(async () => {
    await cleanup();
    expect(await db.project.findUnique({ where: { id: decoyProjectId }, select: { name: true } })).toEqual({ name: "ZZ-TEST leave-me" });
    await db.notification.deleteMany({ where: { OR: [{ projectId: decoyProjectId }, { recipientId: decoyUserId }, { actorId: decoyUserId }] } });
    await db.actionLog.deleteMany({ where: { OR: [{ projectId: decoyProjectId }, { actorId: decoyUserId }, { undoneById: decoyUserId }] } });
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: decoyUserId }, { targetId: { in: [decoyProjectId, decoyUserId] } }] } });
    await db.project.deleteMany({ where: { id: decoyProjectId } });
    await db.user.deleteMany({ where: { id: decoyUserId } });
  });

  it("@APL-2675 @AC1 undoable on a confirmed delete card follows the Trash restore rule", async () => {
    const cases = [
      { who: editor, undoable: false, shows: "none" as const },
      { who: leader, undoable: true, shows: "button" as const },
      { who: superAdmin, undoable: true, shows: "button" as const },
    ];
    for (const c of cases) {
      const taskId = await taskT1();
      const cardId = await pendingCard(c.who, [{ k: "task.delete", taskId }]);
      const done = await confirmCard(c.who, cardId);
      const result = done.messages[0].result!;
      expect(result.undoable, c.who.name).toBe(c.undoable);
      // MessageView renders the Undo button only when undoView is "button".
      expect(undoView(result), c.who.name).toBe(c.shows);
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).deletedAt, c.who.name).not.toBeNull();
    }
  });

  it("@APL-2675 @AC2 an editor's non-delete card stays undoable and Undo still works", async () => {
    const taskId = await taskT1();
    const cardId = await pendingCard(editor, [{ k: "task.edit", taskId, title: "T1 revised" }]);
    const done = await confirmCard(editor, cardId);
    const result = done.messages[0].result!;
    expect(result.undoable).toBe(true);
    expect(undoView(result)).toBe("button");
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).title).toBe("T1 revised");
    const undone = await undoCard(editor, cardId);
    expect(undone.messages[0].result).toMatchObject({ undoable: true, undoneAt: expect.any(String) });
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).title).toBe("T1");
  });

  it("@APL-2675 @AC3 an editor who calls Undo on a delete card is still refused and T1 stays in Trash", async () => {
    const taskId = await taskT1();
    const cardId = await pendingCard(editor, [{ k: "task.delete", taskId }]);
    const done = await confirmCard(editor, cardId);
    expect(done.messages[0].result!.undoable).toBe(false);
    expect(undoView(done.messages[0].result!)).toBe("none");
    const err = await undoCard(editor, cardId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, message: "Only the project Leader or an Admin can do this." });
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).deletedAt).not.toBeNull();
    expect(await db.actionLog.count({ where: { action: "undo", targetId: taskId } })).toBe(0);
  });

  it("@APL-2675 a mixed delete-and-edit card hides Undo for the whole card", async () => {
    const toTrash = await taskT1();
    const toEdit = await createTask(leader, projectId, { title: "T1 edit", dueDate: istDate(1) });
    const cardId = await pendingCard(editor, [
      { k: "task.delete", taskId: toTrash },
      { k: "task.edit", taskId: toEdit, title: "T1 edit revised" },
    ]);
    const done = await confirmCard(editor, cardId);
    const result = done.messages[0].result!;
    expect(result.undoable).toBe(false);
    expect(undoView(result)).toBe("none");
    expect((await db.task.findUniqueOrThrow({ where: { id: toTrash } })).deletedAt).not.toBeNull();
    expect((await db.task.findUniqueOrThrow({ where: { id: toEdit } })).title).toBe("T1 edit revised");
    const err = await undoCard(editor, cardId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, message: "Only the project Leader or an Admin can do this." });
    expect((await db.task.findUniqueOrThrow({ where: { id: toTrash } })).deletedAt).not.toBeNull();
    expect((await db.task.findUniqueOrThrow({ where: { id: toEdit } })).title).toBe("T1 edit revised");
    expect(await db.actionLog.count({ where: { action: "undo", targetId: { in: [toTrash, toEdit] } } })).toBe(0);
  });
});
