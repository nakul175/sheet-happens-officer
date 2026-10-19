// APL-2655 test data, shared by tests/apl-2655.test.ts and tests/e2e/local/APL-2655.test.ts.
// Thrown-away people and projects use ZZ-TEST names and nakul17+ aliases, as in APL-2522.test.ts.
// cleanupZz() archives the projects and deactivates the people; call it from afterAll.
import { expect } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { account, superAdmin, task, type Account } from "./helpers";

export const db = new PrismaClient();

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
const people: Account[] = [];
const projectIds: string[] = [];

/** A throwaway person. The display name starts with ZZ-TEST; the address is a run-unique nakul17+ alias. */
async function zzAccount(role: string) {
  const n = seq++;
  const email = `nakul17+zz-2655-${RUN}-${role.toLowerCase()}-${n}@aplyd.com`;
  const who = await account(`ZZ-TEST ${role} ${RUN}-${n}`, email);
  people.push(who);
  return who;
}

async function zzProject(leader: Account, editor: Account) {
  const r = await leader.c.post("/api/projects", { name: `ZZ-TEST ${RUN}-${seq++}`, leaderId: leader.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  projectIds.push(id);
  expect((await leader.c.post(`/api/projects/${id}/members`, { userId: editor.id, role: "EDITOR" })).status).toBe(201);
  return id;
}

/** A Leader and an Editor; the Editor deleted their task T1. Returns the task.deleted log row. */
export async function editorDeletedT1() {
  const lead = await zzAccount("Leader");
  const ed = await zzAccount("Editor");
  const projectId = await zzProject(lead, ed);
  const title = `ZZ-TEST T1 ${RUN}-${seq++}`;
  const t = await task(lead, projectId, { title, assigneeId: ed.id });
  expect((await ed.c.del(`/api/tasks/${t}`)).status).toBeLessThan(300);
  const row = await db.actionLog.findFirstOrThrow({ where: { action: "task.deleted", targetId: t, actorId: ed.id }, orderBy: { createdAt: "desc" } });
  return { lead, ed, projectId, t, title, row };
}

/** What Undo could change: the log row, the task's Trash state and the undo rows. */
export async function snapshot(taskId: string, logId: string) {
  const [log, taskRow, undoCount] = await Promise.all([
    db.actionLog.findUniqueOrThrow({ where: { id: logId } }),
    db.task.findUniqueOrThrow({ where: { id: taskId } }),
    db.actionLog.count({ where: { action: "undo", targetId: taskId } }),
  ]);
  return {
    undoneAt: log.undoneAt?.toISOString() ?? null,
    undoneById: log.undoneById,
    deletedAt: taskRow.deletedAt?.toISOString() ?? null,
    updatedAt: taskRow.updatedAt.toISOString(),
    undoCount,
  };
}

/** Archive every ZZ-TEST project and deactivate every ZZ-TEST person this run made. */
export async function cleanupZz() {
  const sa = await superAdmin();
  const problems: string[] = [];
  for (const id of projectIds.splice(0)) {
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
  for (const who of people.splice(0)) {
    const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
    if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) {
      problems.push(`deactivate ${who.email}: ${off.status} ${JSON.stringify(off.json)}`);
    }
  }
  expect(problems, problems.join("\n")).toEqual([]);
}
