// APL-2679 story spec: a done-flag move writes one task.reopened row per task it reopens.
// Runs against a local server and a local database only. Any other host is refused before a request is sent.
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { account, project, task, withVersion, type Account } from "../../helpers";

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function refuseRemote(label: string, raw: string | undefined) {
  if (!raw) return;
  const host = new URL(raw).hostname.toLowerCase();
  if (!LOCAL.has(host)) throw new Error(`Refusing to run APL-2679 against a non-local ${label} (${host}).`);
}
refuseRemote("TASKBOARD_URL", process.env.TASKBOARD_URL);
refuseRemote("DATABASE_URL", process.env.DATABASE_URL);

const db = new PrismaClient();
afterAll(() => db.$disconnect());

const RUN = Date.now().toString(36);
const title = (label: string) => `ZZ-TEST ${label} ${RUN}`;

/** A lead who manages Sections and an editor who closes tasks, so the mover and the closer differ. */
async function setup() {
  const lead = await account("lead");
  const editor = await account("editor");
  const p = await project(lead, lead, [{ who: editor }]);
  return { lead, editor, p };
}

async function closeAs(who: Account, id: string) {
  const r = await who.c.post(`/api/tasks/${id}/complete`, await withVersion(who, id));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}

const rows = (projectId: string, action: string, since: Date) =>
  db.actionLog.findMany({ where: { projectId, action, targetType: "task", createdAt: { gte: since } }, orderBy: { targetId: "asc" } });

describe("APL-2679 done-flag move logs reopened tasks qa:TC missing", () => {
  it("writes one task.reopened row per reopened task, with the mover as actor qa:TC missing", async () => {
    const { lead, editor, p } = await setup();
    const reopening = [await task(lead, p.id, { title: title("old a"), sectionId: p.todo }), await task(lead, p.id, { title: title("old b"), sectionId: p.todo })];
    for (const id of reopening) await closeAs(editor, id);
    for (const id of reopening) expect((await lead.c.get(`/api/tasks/${id}`)).json.task.sectionId).toBe(p.done);

    const since = new Date();
    const r = await lead.c.patch(`/api/projects/${p.id}/sections/${p.doing}`, { isDone: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);

    for (const id of reopening) expect((await lead.c.get(`/api/tasks/${id}`)).json.task.completedAt).toBeNull();
    const reopened = await rows(p.id, "task.reopened", since);
    expect(reopened.map((x) => x.targetId)).toEqual([...reopening].sort());
    for (const row of reopened) {
      expect(row.actorId).toBe(lead.id);
      expect(row.beforeState).toMatchObject({ completedAt: expect.any(String) });
      expect(row.afterState).toEqual({ completedAt: null, viaDoneSection: true });
    }
    // The move's own row lists the same tasks, so Undo and the per-task rows agree.
    const move = await db.actionLog.findUniqueOrThrow({ where: { id: r.headers.get("x-undo-id")! } });
    expect(move.action).toBe("section.done_changed");
    expect(move.actorId).toBe(lead.id);
    expect([...(move.beforeState as { reopenedTaskIds: string[] }).reopenedTaskIds].sort()).toEqual([...reopening].sort());
  });

  it("writes no task.reopened row when the old done section has no closed task qa:TC missing", async () => {
    const { lead, p } = await setup();
    await task(lead, p.id, { title: title("open"), sectionId: p.doing });
    const since = new Date();
    expect((await lead.c.patch(`/api/projects/${p.id}/sections/${p.doing}`, { isDone: true })).status).toBe(200);
    expect(await rows(p.id, "task.reopened", since)).toHaveLength(0);
  });

  it("still writes one task.completed row per open task in the new done section qa:TC missing", async () => {
    const { lead, editor, p } = await setup();
    const was = await task(lead, p.id, { title: title("was done"), sectionId: p.todo });
    await closeAs(editor, was);
    const closing = [await task(lead, p.id, { title: title("new a"), sectionId: p.doing }), await task(lead, p.id, { title: title("new b"), sectionId: p.doing })];

    const since = new Date();
    const r = await lead.c.patch(`/api/projects/${p.id}/sections/${p.doing}`, { isDone: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);

    for (const id of closing) expect((await lead.c.get(`/api/tasks/${id}`)).json.task.completedAt).not.toBeNull();
    const completed = await rows(p.id, "task.completed", since);
    expect(completed.map((x) => x.targetId)).toEqual([...closing].sort());
    for (const row of completed) {
      expect(row.actorId).toBe(lead.id);
      expect(row.afterState).toMatchObject({ viaDoneSection: true });
    }
    expect((await rows(p.id, "task.reopened", since)).map((x) => x.targetId)).toEqual([was]);
  });
});
