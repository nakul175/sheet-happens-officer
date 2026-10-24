// SHO-2671 (APL-2610 AC4). Reopening a parent must not reopen a subtask that was ticked done on its
// own before the parent closed; a subtask that closed with the parent must reopen with it.
// Three ways a parent reopens: the reopen route (reopenTask), the done Section moving (updateSection),
// and a drag out of the done Section (moveTask -> reopenTask). Each AC is checked on all three.
// Setup goes through the app API, like tests/apl-2721.test.ts and tests/apl-2870.test.ts.
// No qa:TC id is assigned on the issue, so every title says qa:TC missing.
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { task, withVersion, type Account } from "./helpers";
import { zzTestData } from "./zz-test-data";

const db = new PrismaClient();
const zz = zzTestData("2671");

afterAll(async () => {
  const problems = await zz.cleanUp();
  expect(problems, problems.join("\n")).toEqual([]);
}, 120000);

/** completedAt of a task, read through the API as the page sees it. */
const completedAt = async (who: Account, id: string) => {
  const res = await who.c.get(`/api/tasks/${id}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.task.completedAt as string | null;
};
const isDone = async (who: Account, id: string) => (await completedAt(who, id)) !== null;
const isOpen = async (who: Account, id: string) => (await completedAt(who, id)) === null;

/** P in the "In progress" section, with the subtasks it is given. */
async function parentWith(who: Account, proj: { id: string; doing: string }, subtasks: number) {
  const parent = await task(who, proj.id, { dueDate: "2031-03-20", title: "ZZ-TEST P", sectionId: proj.doing });
  const subs: string[] = [];
  for (let i = 0; i < subtasks; i++) subs.push(await task(who, proj.id, { title: `ZZ-TEST S${i}`, parentId: parent }));
  return { parent, subs };
}

const complete = async (who: Account, id: string, body: Record<string, unknown> = {}) =>
  who.c.post(`/api/tasks/${id}/complete`, await withVersion(who, id, body));
const reopen = async (who: Account, id: string) => who.c.post(`/api/tasks/${id}/reopen`);
/** The drag gesture is POST /api/tasks/[id]/move (src/app/api/tasks/[id]/move/route.ts:12).
 *  PATCH only edits fields and ignores sectionId, so a PATCH-based "drag" silently does nothing. */
const moveTo = async (who: Account, id: string, sectionId: string) =>
  who.c.post(`/api/tasks/${id}/move`, await withVersion(who, id, { sectionId }));

/** Which of these subtasks closed on their own: they carry a completion row with no `withParent` (APL-2721). */
async function ownCompletionRows(projectId: string, ids: string[]) {
  const logs = await db.actionLog.findMany({
    where: { projectId, action: "task.completed", targetId: { in: ids } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { targetId: true, afterState: true },
  });
  const latest = new Map<string, { withParent?: unknown } | null>();
  for (const log of logs) if (!latest.has(log.targetId)) latest.set(log.targetId, (log.afterState ?? null) as { withParent?: unknown } | null);
  return ids.filter((id) => latest.has(id) && !(latest.get(id) as { withParent?: string } | null)?.withParent);
}


describe("qa:TC missing SHO-2671 AC1: subtasks completed with the parent reopen with it", () => {
  it("qa:TC missing cascade complete then reopen route reopens every subtask", async () => {
    const lead = await zz.person("lead");
    const proj = await zz.project(lead);
    const { parent, subs } = await parentWith(lead, proj, 2);
    expect((await complete(lead, parent, { completeAll: true })).status).toBe(200);
    for (const id of [parent, ...subs]) expect(await isDone(lead, id), id).toBe(true);

    expect((await reopen(lead, parent)).status).toBe(200);
    expect(await isOpen(lead, parent)).toBe(true);
    for (const id of subs) expect(await isOpen(lead, id), id).toBe(true);
    expect(await reopenedIds(proj.id, parent)).toEqual(subs.slice().sort());
  });

  it("qa:TC missing drag out of the done section reopens every subtask", async () => {
    const lead = await zz.person("lead");
    const proj = await zz.project(lead);
    const { parent, subs } = await parentWith(lead, proj, 2);
    expect((await complete(lead, parent, { completeAll: true })).status).toBe(200);
    // proj.todo IS the done section (zz-test-data.ts:35) and completeTask already parked the parent
    // there, so dragging to it would be a no-op. Drag out, to the section that is not done.
    expect((await moveTo(lead, parent, proj.doing)).status).toBe(200);
    expect(await isOpen(lead, parent)).toBe(true);
    for (const id of subs) expect(await isOpen(lead, id), id).toBe(true);
  });

  it("qa:TC missing done-section completion then the reopen route reopens every subtask", async () => {
    const lead = await zz.person("lead");
    const proj = await zz.project(lead);
    const { parent, subs } = await parentWith(lead, proj, 2);
    // The other half of "cascade/complete-with-parent": P's section becomes the done Section, so P
    // closes and completeSubtasks closes both subtasks with it (src/lib/sections.ts:103).
    expect((await lead.c.patch(`/api/projects/${proj.id}/sections/${proj.doing}`, { isDone: true })).status).toBe(200);
    for (const id of [parent, ...subs]) expect(await isDone(lead, id), id).toBe(true);

    expect((await reopen(lead, parent)).status).toBe(200);
    expect(await isOpen(lead, parent)).toBe(true);
    for (const id of subs) expect(await isOpen(lead, id), id).toBe(true);
    expect(await reopenedIds(proj.id, parent)).toEqual(subs.slice().sort());
  });
});

describe("qa:TC missing SHO-2671 AC2: a subtask ticked done on its own stays done", () => {
  it("qa:TC missing own tick before the cascade keeps its completedAt through a reopen", async () => {
    const lead = await zz.person("lead");
    const proj = await zz.project(lead);
    const { parent, subs } = await parentWith(lead, proj, 3);
    const [cascaded, own, cascaded2] = subs;

    // S1 (own) is ticked done on its own before P closes. S0 and S2 close with P.
    expect((await complete(lead, own)).status).toBe(200);
    const ownAt = await completedAt(lead, own);
    expect(ownAt).not.toBeNull();
    expect((await complete(lead, parent, { completeAll: true })).status).toBe(200);
    expect(await completedAt(lead, own)).toBe(ownAt); // the cascade left it alone

    expect((await reopen(lead, parent)).status).toBe(200);
    expect(await isOpen(lead, cascaded)).toBe(true);
    expect(await isOpen(lead, cascaded2)).toBe(true);
    expect(await isDone(lead, own), "S1 ticked on its own stays done").toBe(true);
    expect(await completedAt(lead, own)).toBe(ownAt);
    // Only the cascade subtasks are listed, so Undo never re-closes S1.
    expect(await reopenedIds(proj.id, parent)).toEqual([cascaded, cascaded2].sort());
  });

  it("qa:TC missing done-section move and drag leave an own tick alone", async () => {
    const lead = await zz.person("lead");
    const proj = await zz.project(lead);
    const { parent, subs } = await parentWith(lead, proj, 2);
    const [cascaded, own] = subs;
    expect((await complete(lead, own)).status).toBe(200);
    const ownAt = await completedAt(lead, own);

    // P closes by the done Section moving onto "In progress". S0 closes with it.
    expect((await lead.c.patch(`/api/projects/${proj.id}/sections/${proj.doing}`, { isDone: true })).status).toBe(200);
    expect(await isDone(lead, parent)).toBe(true);
    expect(await isDone(lead, cascaded)).toBe(true);
    expect(await completedAt(lead, own)).toBe(ownAt);

    // The done flag moves to "To do": P and S0 reopen, S1 stays done on its own time.
    expect((await lead.c.patch(`/api/projects/${proj.id}/sections/${proj.todo}`, { isDone: true })).status).toBe(200);
    expect(await isOpen(lead, parent)).toBe(true);
    expect(await isOpen(lead, cascaded)).toBe(true);
    expect(await isDone(lead, own)).toBe(true);
    expect(await completedAt(lead, own)).toBe(ownAt);

    // Same rule through a drag: close P again with completeAll, then drag it out of the done Section.
    // proj.doing is not the done section; proj.todo is, and would make the drag a no-op.
    expect((await complete(lead, parent, { completeAll: true })).status).toBe(200);
    expect((await moveTo(lead, parent, proj.doing)).status).toBe(200);


    expect(await isOpen(lead, parent)).toBe(true);
    expect(await isOpen(lead, cascaded)).toBe(true);
    expect(await isDone(lead, own)).toBe(true);
    expect(await completedAt(lead, own)).toBe(ownAt);
  });
});

describe("qa:TC missing SHO-2671 AC3: a mix reopens only the cascade subtasks", () => {
  it("qa:TC missing reopen route reopens only the ones that closed with the parent", async () => {
    const lead = await zz.person("lead");
    const proj = await zz.project(lead);
    const { parent, subs } = await parentWith(lead, proj, 4);
    const [cascadedA, ownA, cascadedB, ownB] = subs;
    // Two ticked on their own first, in two separate requests so each keeps its own stamp.
    expect((await complete(lead, ownA)).status).toBe(200);
    expect((await complete(lead, ownB)).status).toBe(200);
    const stampA = await completedAt(lead, ownA);
    const stampB = await completedAt(lead, ownB);
    expect(stampA).not.toBe(stampB);
    expect((await complete(lead, parent, { completeAll: true })).status).toBe(200);
    // Their latest completion rows carry no `withParent`; the cascade rows do (APL-2721).
    expect((await ownCompletionRows(proj.id, subs)).sort()).toEqual([ownA, ownB].sort());

    expect((await reopen(lead, parent)).status).toBe(200);
    expect(await isOpen(lead, cascadedA)).toBe(true);
    expect(await isOpen(lead, cascadedB)).toBe(true);
    expect(await completedAt(lead, ownA)).toBe(stampA);
    expect(await completedAt(lead, ownB)).toBe(stampB);
    expect(await reopenedIds(proj.id, parent)).toEqual([cascadedA, cascadedB].sort());
  });

  it("qa:TC missing done-section move keeps the mix apart too", async () => {
    const lead = await zz.person("lead");
    const proj = await zz.project(lead);
    const { parent, subs } = await parentWith(lead, proj, 3);
    const [cascadedA, own, cascadedB] = subs;
    expect((await complete(lead, own)).status).toBe(200);
    const ownAt = await completedAt(lead, own);
    expect((await lead.c.patch(`/api/projects/${proj.id}/sections/${proj.doing}`, { isDone: true })).status).toBe(200);
    expect((await lead.c.patch(`/api/projects/${proj.id}/sections/${proj.todo}`, { isDone: true })).status).toBe(200);

    expect(await isOpen(lead, parent)).toBe(true);
    expect(await isOpen(lead, cascadedA)).toBe(true);
    expect(await isOpen(lead, cascadedB)).toBe(true);
    expect(await completedAt(lead, own)).toBe(ownAt);
    const log = await db.actionLog.findFirstOrThrow({
      where: { projectId: proj.id, action: "section.done_changed", undoneAt: null },
      orderBy: { createdAt: "desc" },
    });
    const before = log.beforeState as { reopenedSubtaskIds?: string[] };
    expect((before.reopenedSubtaskIds ?? []).slice().sort()).toEqual([cascadedA, cascadedB].sort());
  });
});


/** The subtaskIds the reopen of `parent` wrote, so Undo can close them again. */
async function reopenedIds(projectId: string, parent: string) {
  const log = await db.actionLog.findFirstOrThrow({
    where: { projectId, action: "task.reopened", targetId: parent },
    orderBy: { createdAt: "desc" },
  });
  return ((log.afterState as { subtaskIds?: string[] }).subtaskIds ?? []).slice().sort();
}
