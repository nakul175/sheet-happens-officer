// APL-2679 story spec: a done-flag move writes one task.reopened row per task it reopens.
// Runs against a local server and a local database only. Any other host is refused before a request is sent.
// Thrown-away people, projects and tasks use ZZ-TEST names and nakul17+ aliases. afterAll archives the
// projects and deactivates the people through the API, as APL-2522.spec.ts does.
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { account, superAdmin, task, withVersion, type Account } from "../../helpers";

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function refuseRemote(label: string, raw: string | undefined) {
  if (!raw) return;
  const host = new URL(raw).hostname.toLowerCase();
  if (!LOCAL.has(host)) throw new Error(`Refusing to run APL-2679 against a non-local ${label} (${host}).`);
}
refuseRemote("TASKBOARD_URL", process.env.TASKBOARD_URL);
refuseRemote("DATABASE_URL", process.env.DATABASE_URL);

const db = new PrismaClient();

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
const people: Account[] = [];
const projectIds: string[] = [];
const title = (label: string) => `ZZ-TEST ${label} ${RUN}-${seq++}`;

/** A throwaway person. The display name starts with ZZ-TEST; the address is a run-unique nakul17+ alias. */
async function zzAccount(role: string) {
  const n = seq++;
  const who = await account(`ZZ-TEST ${role} ${RUN}-${n}`, `nakul17+zz-2679-${RUN}-${role}-${n}@aplyd.com`);
  people.push(who);
  return who;
}

/** A lead who manages Sections and an editor who closes tasks, so the mover and the closer differ. */
async function setup() {
  const lead = await zzAccount("lead");
  const editor = await zzAccount("editor");
  const r = await lead.c.post("/api/projects", { name: title("project"), leaderId: lead.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  projectIds.push(id);
  expect((await lead.c.post(`/api/projects/${id}/members`, { userId: editor.id, role: "EDITOR" })).status).toBe(201);
  const sections = (await lead.c.get(`/api/projects/${id}`)).json.project.sections as { id: string; isDone: boolean }[];
  const p = { id, todo: sections[0].id, doing: sections[1].id, done: sections.find((s) => s.isDone)!.id };
  return { lead, editor, p };
}

async function closeAs(who: Account, id: string) {
  const r = await who.c.post(`/api/tasks/${id}/complete`, await withVersion(who, id));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}

const rows = (projectId: string, action: string, since: Date) =>
  db.actionLog.findMany({ where: { projectId, action, targetType: "task", createdAt: { gte: since } }, orderBy: { targetId: "asc" } });

afterAll(async () => {
  const sa = await superAdmin();
  const problems: string[] = [];
  for (const id of projectIds) {
    const added = await sa.c.post(`/api/projects/${id}/members`, { userId: sa.id, role: "EDITOR" });
    if (added.status !== 201 && !(added.status === 409 && /already a member/.test(added.json?.error ?? ""))) {
      problems.push(`add member ${id}: ${added.status} ${JSON.stringify(added.json)}`);
    }
    const led = await sa.c.post(`/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
    if (led.status !== 200 && !(led.status === 400 && /already the Leader/.test(led.json?.error ?? ""))) {
      problems.push(`change leader ${id}: ${led.status} ${JSON.stringify(led.json)}`);
    }
    const archived = await sa.c.post(`/api/projects/${id}/archive`);
    if (archived.status !== 200) problems.push(`archive ${id}: ${archived.status} ${JSON.stringify(archived.json)}`);
  }
  for (const who of people) {
    const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
    if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) {
      problems.push(`deactivate ${who.email}: ${off.status} ${JSON.stringify(off.json)}`);
    }
  }
  await db.$disconnect();
  expect(problems, problems.join("\n")).toEqual([]);
});

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

  it("writes no task.reopened row for a done task in Trash qa:TC missing", async () => {
    const { lead, editor, p } = await setup();
    const live = await task(lead, p.id, { title: title("live done"), sectionId: p.todo });
    const trashed = await task(lead, p.id, { title: title("trashed done"), sectionId: p.todo });
    await closeAs(editor, live);
    await closeAs(editor, trashed);
    expect((await lead.c.del(`/api/tasks/${trashed}`)).status).toBeLessThan(300);

    const since = new Date();
    expect((await lead.c.patch(`/api/projects/${p.id}/sections/${p.doing}`, { isDone: true })).status).toBe(200);
    expect((await rows(p.id, "task.reopened", since)).map((x) => x.targetId)).toEqual([live]);
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
