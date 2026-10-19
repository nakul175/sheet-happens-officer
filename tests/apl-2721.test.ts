// APL-2721. Moving the done flag back reopens subtasks that closed with the parent,
// leaves a subtask ticked on its own done, and does not clear a parent sitting in Trash.
// No qa:TC id is assigned on the issue, so every title says qa:TC missing.
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { completeTask, deleteTask, reopenTask, restoreTask } from "../src/lib/tasks";
import { updateSection } from "../src/lib/sections";
import { undoAction } from "../src/lib/undo";
import { task, withVersion, type Account } from "./helpers";
import { zzTestData } from "./zz-test-data";

const db = new PrismaClient();
const zz = zzTestData("2721");

afterAll(async () => {
  const problems = await zz.cleanUp();
  expect(problems, problems.join("\n")).toEqual([]);
}, 120000);

const me = (who: Account) => ({ id: who.id, orgRole: "MEMBER" as const, name: who.name });
const versionOf = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } })).updatedAt.toISOString();
const rowOf = (id: string) => db.task.findUniqueOrThrow({
  where: { id },
  select: { completedAt: true, sectionId: true, deletedAt: true, updatedAt: true },
});
const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Parent P in `sectionId`, with open subtasks A and B. */
async function parentWithOpenSubs(who: Account, sectionId: string, proj: { id: string }) {
  const parent = await task(who, proj.id, { title: "ZZ-TEST P", sectionId });
  const a = await task(who, proj.id, { title: "ZZ-TEST A", parentId: parent });
  const b = await task(who, proj.id, { title: "ZZ-TEST B", parentId: parent });
  return { parent, a, b };
}

describe("qa:TC missing APL-2721 unit: done-flag reopen", () => {
  it("qa:TC missing cascaded subtasks reopen with their parent", async () => {
    const lead = await zz.person("lead");
    const proj = await zz.project(lead);
    const { parent, a, b } = await parentWithOpenSubs(lead, proj.doing, proj);
    // "In progress" becomes the done section, so P, A and B close together.
    await updateSection(me(lead), proj.id, proj.doing, { isDone: true });
    for (const id of [parent, a, b]) expect(iso((await rowOf(id)).completedAt)).not.toBeNull();

    // The done flag moves to "To do". P, A and B reopen.
    await updateSection(me(lead), proj.id, proj.todo, { isDone: true });
    for (const id of [parent, a, b]) expect(iso((await rowOf(id)).completedAt), id).toBeNull();
    const log = await db.actionLog.findFirstOrThrow({
      where: { projectId: proj.id, action: "section.done_changed", undoneAt: null },
      orderBy: { createdAt: "desc" },
    });
    const before = log.beforeState as { reopenedSubtaskIds: string[] };
    expect(before.reopenedSubtaskIds.slice().sort()).toEqual([a, b].sort());

    // Undo closes them together again, on one completedAt, so the next move still treats A and B as cascaded.
    await undoAction(me(lead), log.id);
    const again = await Promise.all([parent, a, b].map(rowOf));
    expect(again.every((r) => r.completedAt)).toBe(true);
    expect(again[1].completedAt!.getTime()).toBe(again[0].completedAt!.getTime());
    expect(again[2].completedAt!.getTime()).toBe(again[0].completedAt!.getTime());
  });

  it("qa:TC missing a subtask ticked done on its own stays done", async () => {
    const lead = await zz.person("lead");

    // Done-flag move: C was ticked before P closed. A closed with P.
    const flag = await zz.project(lead);
    const parent = await task(lead, flag.id, { title: "ZZ-TEST P", sectionId: flag.doing });
    const cascaded = await task(lead, flag.id, { title: "ZZ-TEST A", parentId: parent });
    const own = await task(lead, flag.id, { title: "ZZ-TEST C", parentId: parent });
    await completeTask(me(lead), own, await versionOf(own));
    const ownAt = iso((await rowOf(own)).completedAt);
    await updateSection(me(lead), flag.id, flag.doing, { isDone: true });
    await updateSection(me(lead), flag.id, flag.todo, { isDone: true });
    expect(iso((await rowOf(parent)).completedAt)).toBeNull();
    expect(iso((await rowOf(cascaded)).completedAt)).toBeNull();
    expect(iso((await rowOf(own)).completedAt)).toBe(ownAt);

    // reopenTask: same rule, on a parent closed by hand.
    const hand = await zz.project(lead);
    const parent2 = await task(lead, hand.id, { title: "ZZ-TEST P", sectionId: hand.doing });
    const cascaded2 = await task(lead, hand.id, { title: "ZZ-TEST A", parentId: parent2 });
    const own2 = await task(lead, hand.id, { title: "ZZ-TEST C", parentId: parent2 });
    await completeTask(me(lead), own2, await versionOf(own2));
    const own2At = iso((await rowOf(own2)).completedAt);
    await completeTask(me(lead), parent2, await versionOf(parent2), true);
    await reopenTask(me(lead), parent2);
    expect(iso((await rowOf(parent2)).completedAt)).toBeNull();
    expect(iso((await rowOf(cascaded2)).completedAt)).toBeNull();
    expect(iso((await rowOf(own2)).completedAt)).toBe(own2At);

    const reopened = await db.actionLog.findFirstOrThrow({
      where: { projectId: hand.id, action: "task.reopened", targetId: parent2 },
      orderBy: { createdAt: "desc" },
    });
    await undoAction(me(lead), reopened.id);
    const back = await rowOf(cascaded2);
    const still = await rowOf(own2);
    expect(back.completedAt).not.toBeNull();
    expect(iso(still.completedAt)).toBe(own2At);
    expect(back.completedAt!.getTime()).not.toBe(still.completedAt!.getTime());
  });

  it("qa:TC missing undoing a reopen keeps the time of a subtask ticked done on its own since", async () => {
    const lead = await zz.person("lead");
    const proj = await zz.project(lead);
    const { parent, a, b } = await parentWithOpenSubs(lead, proj.doing, proj);
    await completeTask(me(lead), parent, await versionOf(parent), true);
    const parentAt = iso((await rowOf(parent)).completedAt);
    await reopenTask(me(lead), parent);
    for (const id of [parent, a, b]) expect(iso((await rowOf(id)).completedAt), id).toBeNull();

    // A is ticked done on its own after the reopen. B stays open.
    await completeTask(me(lead), a, await versionOf(a));
    const aOwnAt = iso((await rowOf(a)).completedAt);
    expect(aOwnAt).not.toBeNull();
    expect(aOwnAt).not.toBe(parentAt);

    const reopened = await db.actionLog.findFirstOrThrow({
      where: { projectId: proj.id, action: "task.reopened", targetId: parent },
      orderBy: { createdAt: "desc" },
    });
    await undoAction(me(lead), reopened.id);
    // P and B close again on P's original time. A keeps the time it was ticked.
    expect(iso((await rowOf(parent)).completedAt)).toBe(parentAt);
    expect(iso((await rowOf(b)).completedAt)).toBe(parentAt);
    expect(iso((await rowOf(a)).completedAt)).toBe(aOwnAt);
  });

  it("qa:TC missing a trashed parent stays complete in its original section", async () => {
    const lead = await zz.person("lead");
    const proj = await zz.project(lead);
    const trashed = await task(lead, proj.id, { title: "ZZ-TEST T", sectionId: proj.doing });
    const live = await task(lead, proj.id, { title: "ZZ-TEST Live", sectionId: proj.doing });
    await updateSection(me(lead), proj.id, proj.doing, { isDone: true });
    const beforeTrash = await rowOf(trashed);
    expect(beforeTrash.completedAt).not.toBeNull();
    expect(beforeTrash.sectionId).toBe(proj.doing);
    await deleteTask(me(lead), trashed);
    const inTrash = await rowOf(trashed);
    expect(inTrash.deletedAt).not.toBeNull();

    await updateSection(me(lead), proj.id, proj.todo, { isDone: true });
    const afterMove = await rowOf(trashed);
    expect(iso(afterMove.completedAt)).toBe(iso(inTrash.completedAt));
    expect(afterMove.sectionId).toBe(proj.doing);
    expect(afterMove.deletedAt?.toISOString()).toBe(inTrash.deletedAt?.toISOString());
    expect(afterMove.updatedAt.toISOString()).toBe(inTrash.updatedAt.toISOString());
    expect(iso((await rowOf(live)).completedAt)).toBeNull();

    await restoreTask(me(lead), trashed);
    const restored = await rowOf(trashed);
    expect(iso(restored.completedAt)).toBe(iso(inTrash.completedAt));
    expect(restored.sectionId).toBe(proj.doing);
    expect(restored.deletedAt).toBeNull();
    expect((await db.section.findUniqueOrThrow({ where: { id: proj.doing } })).isDone).toBe(false);
  });
});

describe("qa:TC missing APL-2721 route: done-flag reopen", () => {
  it("qa:TC missing cascaded subtasks reopen with their parent", async () => {
    const lead = await zz.person("lead");
    const proj = await zz.project(lead);
    const parent = await task(lead, proj.id, { title: "ZZ-TEST P", sectionId: proj.doing });
    const a = await task(lead, proj.id, { title: "ZZ-TEST A", parentId: parent });
    const b = await task(lead, proj.id, { title: "ZZ-TEST B", parentId: parent });
    expect((await lead.c.patch(`/api/projects/${proj.id}/sections/${proj.doing}`, { isDone: true })).status).toBe(200);
    const closed = await lead.c.get(`/api/tasks/${parent}`);
    expect(closed.status).toBe(200);
    expect(closed.json.task.completedAt).not.toBeNull();
    const subs = closed.json.task.subtaskList as { id: string; completedAt: string | null }[];
    expect(subs.find((s) => s.id === a)?.completedAt).not.toBeNull();
    expect(subs.find((s) => s.id === b)?.completedAt).not.toBeNull();

    const moved = await lead.c.patch(`/api/projects/${proj.id}/sections/${proj.todo}`, { isDone: true });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    const open = await lead.c.get(`/api/tasks/${parent}`);
    expect(open.json.task.completedAt).toBeNull();
    expect(open.json.task.sectionId).toBe(proj.doing);
    const reopened = open.json.task.subtaskList as { id: string; completedAt: string | null }[];
    expect(reopened.find((s) => s.id === a)?.completedAt).toBeNull();
    expect(reopened.find((s) => s.id === b)?.completedAt).toBeNull();
  });

  it("qa:TC missing a subtask ticked done on its own stays done", async () => {
    const lead = await zz.person("lead");

    const flag = await zz.project(lead);
    const parent = await task(lead, flag.id, { title: "ZZ-TEST P", sectionId: flag.doing });
    const cascaded = await task(lead, flag.id, { title: "ZZ-TEST A", parentId: parent });
    const own = await task(lead, flag.id, { title: "ZZ-TEST C", parentId: parent });
    expect((await lead.c.post(`/api/tasks/${own}/complete`, await withVersion(lead, own))).status).toBe(200);
    const ownBefore = (await lead.c.get(`/api/tasks/${own}`)).json.task.completedAt as string;
    expect((await lead.c.patch(`/api/projects/${flag.id}/sections/${flag.doing}`, { isDone: true })).status).toBe(200);
    expect((await lead.c.patch(`/api/projects/${flag.id}/sections/${flag.todo}`, { isDone: true })).status).toBe(200);
    const afterFlag = await lead.c.get(`/api/tasks/${parent}`);
    expect(afterFlag.json.task.completedAt).toBeNull();
    const flagSubs = afterFlag.json.task.subtaskList as { id: string; completedAt: string | null }[];
    expect(flagSubs.find((s) => s.id === cascaded)?.completedAt).toBeNull();
    expect(flagSubs.find((s) => s.id === own)?.completedAt).toBe(ownBefore);

    const hand = await zz.project(lead);
    const parent2 = await task(lead, hand.id, { title: "ZZ-TEST P", sectionId: hand.doing });
    const cascaded2 = await task(lead, hand.id, { title: "ZZ-TEST A", parentId: parent2 });
    const own2 = await task(lead, hand.id, { title: "ZZ-TEST C", parentId: parent2 });
    expect((await lead.c.post(`/api/tasks/${own2}/complete`, await withVersion(lead, own2))).status).toBe(200);
    const own2Before = (await lead.c.get(`/api/tasks/${own2}`)).json.task.completedAt as string;
    expect((await lead.c.post(`/api/tasks/${parent2}/complete`, await withVersion(lead, parent2, { completeAll: true }))).status).toBe(200);
    expect((await lead.c.post(`/api/tasks/${parent2}/reopen`)).status).toBe(200);
    const afterReopen = await lead.c.get(`/api/tasks/${parent2}`);
    expect(afterReopen.json.task.completedAt).toBeNull();
    const handSubs = afterReopen.json.task.subtaskList as { id: string; completedAt: string | null }[];
    expect(handSubs.find((s) => s.id === cascaded2)?.completedAt).toBeNull();
    expect(handSubs.find((s) => s.id === own2)?.completedAt).toBe(own2Before);
  });

  it("qa:TC missing a trashed parent stays complete in its original section", async () => {
    const lead = await zz.person("lead");
    const proj = await zz.project(lead);
    const trashed = await task(lead, proj.id, { title: "ZZ-TEST T", sectionId: proj.doing });
    const live = await task(lead, proj.id, { title: "ZZ-TEST Live", sectionId: proj.doing });
    expect((await lead.c.patch(`/api/projects/${proj.id}/sections/${proj.doing}`, { isDone: true })).status).toBe(200);
    const closed = await lead.c.get(`/api/tasks/${trashed}`);
    const completedAt = closed.json.task.completedAt as string;
    expect(completedAt).toBeTruthy();
    expect(closed.json.task.sectionId).toBe(proj.doing);
    expect((await lead.c.del(`/api/tasks/${trashed}`)).status).toBe(204);

    expect((await lead.c.patch(`/api/projects/${proj.id}/sections/${proj.todo}`, { isDone: true })).status).toBe(200);
    const trash = await lead.c.get(`/api/projects/${proj.id}/trash`);
    expect(trash.status).toBe(200);
    expect((trash.json.items as { id: string }[]).some((i) => i.id === trashed)).toBe(true);
    const held = await rowOf(trashed);
    expect(iso(held.completedAt)).toBe(completedAt);
    expect(held.sectionId).toBe(proj.doing);
    expect(held.deletedAt).not.toBeNull();
    expect((await lead.c.get(`/api/tasks/${live}`)).json.task.completedAt).toBeNull();

    expect((await lead.c.post(`/api/tasks/${trashed}/restore`)).status).toBe(200);
    const restored = await lead.c.get(`/api/tasks/${trashed}`);
    expect(restored.status).toBe(200);
    expect(restored.json.task.completedAt).toBe(completedAt);
    expect(restored.json.task.sectionId).toBe(proj.doing);
    expect(restored.json.task.section.isDone).toBe(false);
    expect(restored.json.task.section.name).toBe("In progress");
  });
});
