import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { BASE, Client, task, withVersion } from "./helpers";
import { workloadSummary, workloadTasks } from "../src/lib/workload";
import { workloadFixture } from "./workload-2589-fixtures";

if (new URL(BASE).hostname !== "localhost") throw new Error("Workload API acceptance requires localhost, never a live site.");
let f: Awaited<ReturnType<typeof workloadFixture>>;
beforeAll(async () => { f = await workloadFixture(); }, 120000);
afterAll(async () => { await f?.cleanup(); }, 120000);

it("counts open subtasks, excludes archived/Trash/completed work and matches each Leader drill-down", async () => {
  const response = await f.lead.c.get("/api/workload"); expect(response.status).toBe(200);
  const row = response.json.items.find((p: { id: string }) => p.id === f.worker.id);
  expect(row).toMatchObject({ open: 6, due: 2, overdue: 1, approval: 1, blocked: 1 });
  expect(response.json.items.some((p: { id: string }) => p.id === f.outsider.id)).toBe(false);
  expect(JSON.stringify(response.json)).not.toContain(f.outsider.email);
  const expected: [string, string[]][] = [["", [f.parent, f.child, f.sixthDay, f.seventhDay, f.undated, f.approval]], ["&due=next7", [f.child, f.sixthDay]], ["&f=overdue", [f.parent]], ["&f=awaiting", [f.approval]], ["&f=blocked", [f.parent]]];
  for (const [filter, ids] of expected) {
    const list = await f.lead.c.get(`/api/workload?assignee=${f.worker.id}${filter}`);
    expect(list.status).toBe(200); expect(list.json.total).toBe(ids.length);
    expect(list.json.items.map((t: { id: string }) => t.id).sort()).toEqual([...ids].sort());
  }
  const admin = await f.root.c.get("/api/workload"); expect(admin.status).toBe(200);
  expect(admin.json.items.find((p: { id: string }) => p.id === f.worker.id).open).toBe(8);
});
it("refuses ordinary Members, Viewers, out-of-scope people and foreign cursors without leaking counts", async () => {
  for (const person of [f.worker, f.viewer, f.outsider]) {
    expect((await person.c.get("/api/workload")).status).toBe(404);
    expect((await person.c.get("/api/workload?f=unknown")).status).toBe(404);
  }
  const missing = await f.lead.c.get("/api/workload?assignee=does-not-exist");
  const hidden = await f.lead.c.get(`/api/workload?assignee=${f.outsider.id}`);
  expect(hidden.status).toBe(404); expect(hidden.json).toEqual(missing.json);
  expect((await f.root.c.get(`/api/workload?assignee=${f.worker.id}&cursor=${f.archivedTask}`)).status).toBe(404);
  expect((await new Client().get("/api/workload")).status).toBe(401);
});
it("excludes CRM-hidden tasks from real database counts and rows under the existing privacy policy", async () => {
  vi.stubEnv("CRM_VISIBLE", "off");
  try {
    const actor = { id: f.root.id, orgRole: "SUPER_ADMIN" as const };
    const summary = await workloadSummary(actor);
    expect(summary.items.find(p => p.id === f.worker.id)?.open).toBe(7);
    const list = await workloadTasks(actor, f.worker.id, "open");
    expect(list.total).toBe(7); expect(JSON.stringify(list)).not.toContain(f.dealId); expect(JSON.stringify(list)).not.toContain(f.dealTask);
  } finally { vi.unstubAllEnvs(); }
});
it("retains versioned assignment, notice, Undo and Viewer/non-member refusals", async () => {
  for (const target of [f.viewer, f.outsider]) expect((await f.root.c.post(`/api/tasks/${f.parent}/assign`, await withVersion(f.root, f.parent, { assigneeId: target.id }))).status).toBe(400);
  const payload = await withVersion(f.root, f.parent, { assigneeId: f.lead.id });
  const result = await f.root.c.post(`/api/tasks/${f.parent}/assign`, payload); expect(result.status).toBe(200);
  const undo = result.headers.get("x-undo-id"); expect(undo).toBeTruthy();
  expect((await f.root.c.post(`/api/tasks/${f.parent}/assign`, { ...payload, assigneeId: f.worker.id })).status).toBe(409);
  const notices = await f.lead.c.get("/api/notifications"); expect(notices.status).toBe(200);
  expect(notices.json.items.some((n: { text: string }) => n.text.includes(`Workload blocked parent ${f.run}`))).toBe(true);
  expect((await f.root.c.post(`/api/actions/${undo}/undo`, {})).status).toBe(200);
  expect((await f.root.c.get(`/api/tasks/${f.parent}`)).json.task.assignee.id).toBe(f.worker.id);
});
it("paginates the matching list without duplicates or skipped tasks", async () => {
  for (let i = 0; i < 26; i++) await task(f.root, f.projectId, { title: `ZZ-TEST Workload pagination ${f.run} ${i}`, assigneeId: f.worker.id });
  const first = await f.lead.c.get(`/api/workload?assignee=${f.worker.id}`); expect(first.status).toBe(200);
  expect(first.json.total).toBe(32); expect(first.json.items).toHaveLength(25); expect(first.json.nextCursor).toBeTruthy();
  const second = await f.lead.c.get(`/api/workload?assignee=${f.worker.id}&cursor=${first.json.nextCursor}`); expect(second.status).toBe(200);
  expect(second.json.items).toHaveLength(7); expect(second.json.nextCursor).toBeNull();
  const all = [...first.json.items, ...second.json.items].map((t: { id: string }) => t.id);
  expect(new Set(all).size).toBe(32);
});
