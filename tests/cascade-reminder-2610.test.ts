// SHO-2677: a focused API-seeded regression for APL-2610 AC5. Only this new test file changes.
// Product reminder writes are the behavior under test; fixture setup/cleanup uses HTTP, DB reads assert outcomes.
import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { sendReminders } from "../src/lib/jobs";
import { account, BASE, istDate, project, superAdmin, task, type Account } from "./helpers";

const run = `${Date.now().toString(36)}-${process.pid}`;
let root: Account, worker: Account;
let p: Awaited<ReturnType<typeof project>>;

beforeAll(async () => {
  const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) || !/^\/sho_test(?:_[\w-]+)?$/.test(database.pathname)) throw new Error("SHO-2677 requires a local sho_test database");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname)) throw new Error("SHO-2677 refuses a non-local API");
  root = await superAdmin();
  worker = await account("ZZ-TEST 2677 worker", `nakul17+zz-2677-${run}-worker@aplyd.com`);
  p = await project(root, root, [{ who: worker }], `ZZ-TEST 2677 cascade ${run}`);
});

afterAll(async () => {
  const failures: string[] = [];
  if (p) {
    const r = await root.c.post(`/api/projects/${p.id}/archive`);
    if (r.status !== 200) failures.push(`archive: ${r.status}`);
  }
  if (worker) {
    const r = await root.c.post(`/api/team/${worker.id}/deactivate`, { reassign: "leaders" });
    if (r.status !== 200) failures.push(`deactivate: ${r.status}`);
  }
  expect(failures).toEqual([]);
});

const reminders = (id: string) => db.notification.findMany({ where: { taskId: id, recipientId: worker.id, type: { in: ["TASK_DUE_TOMORROW", "TASK_DUE_TODAY", "TASK_OVERDUE"] } }, select: { taskId: true, type: true } });

it("qa:TC missing SHO-2677 AC1: a due-today subtask completed by the section done-flag cascade gets no reminder and its parent stays complete", async () => {
  const parent = await task(root, p.id, { title: `ZZ-TEST 2677 completed parent ${run}`, sectionId: p.doing, assigneeId: worker.id });
  const child = await task(root, p.id, { title: `ZZ-TEST 2677 completed child ${run}`, parentId: parent, dueDate: istDate(0), assigneeId: worker.id });
  expect(await reminders(child)).toEqual([]);
  const moved = await root.c.patch(`/api/projects/${p.id}/sections/${p.doing}`, { isDone: true });
  expect(moved.status).toBe(200);
  for (const id of [parent, child]) expect((await root.c.get(`/api/tasks/${id}`)).json.task.completedAt).not.toBeNull();
  await sendReminders();
  expect(await reminders(child)).toEqual([]);
  expect((await root.c.get(`/api/tasks/${parent}`)).json.task.completedAt).not.toBeNull();
});

it("qa:TC missing SHO-2677 AC2: an ordinary due-today open subtask gets exactly one reminder while its parent stays open", async () => {
  const parent = await task(root, p.id, { title: `ZZ-TEST 2677 open parent ${run}`, sectionId: p.todo, assigneeId: worker.id });
  const child = await task(root, p.id, { title: `ZZ-TEST 2677 open child ${run}`, parentId: parent, dueDate: istDate(0), assigneeId: worker.id });
  expect(await reminders(child)).toEqual([]);
  await sendReminders();
  expect(await reminders(child)).toEqual([{ taskId: child, type: "TASK_DUE_TODAY" }]);
  expect((await root.c.get(`/api/tasks/${parent}`)).json.task.completedAt).toBeNull();
});
