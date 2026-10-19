// APL-2720 AC1@v1.0, aging half (moved here from the story spec, Pam D1 on #85/#97).
// Pam's seven ages read 30/30/29/2/1/1/0 days left. Tasks are created and deleted through the API, so deletedAt is real.
// The clock moves, not the row: only Date is faked while listTrash (read only) runs, so nothing is written to the database.
// The Time left text for each daysLeft value (30, 29, 2, 1, 0) is checked in tests/trash-days-left.test.tsx.
// ZZ-TEST names and a nakul17+ alias. afterAll archives the project and deactivates the person through the API.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listTrash } from "../src/lib/tasks";
import { account, superAdmin, task, type Account } from "./helpers";

const DAY = 86400_000;
const HOUR = 3600_000;
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;

// Pam's live seed: 0 days, under 1 day, 1, 28, 29, under 30, and 30 days.
const AGES = [
  { label: "1 hour", age: HOUR, daysLeft: 30 },
  { label: "23 hours", age: DAY - HOUR, daysLeft: 30 },
  { label: "1 day 1 hour", age: DAY + HOUR, daysLeft: 29 },
  { label: "28 days 1 hour", age: 28 * DAY + HOUR, daysLeft: 2 },
  { label: "29 days 1 hour", age: 29 * DAY + HOUR, daysLeft: 1 },
  { label: "29 days 23 hours", age: 30 * DAY - HOUR, daysLeft: 1 },
  { label: "30 days 1 hour", age: 30 * DAY + HOUR, daysLeft: 0 },
] as const;

let leader: Account;
let projectId = "";
const deleted = new Map<string, { id: string; deletedAt: number }>();

beforeAll(async () => {
  leader = await account(`ZZ-TEST 2720 leader ${RUN}`, `nakul17+zz-2720-${RUN}-leader@aplyd.com`);
  const p = await leader.c.post("/api/projects", { name: `ZZ-TEST 2720 aging ${RUN}`, leaderId: leader.id });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  projectId = p.json.project.id as string;
  for (const a of AGES) {
    const title = `ZZ-TEST 2720 ${a.label} ${RUN}`;
    const id = await task(leader, projectId, { title });
    expect((await leader.c.del(`/api/tasks/${id}`)).status).toBe(204);
  }
  const listed = await leader.c.get(`/api/projects/${projectId}/trash`);
  expect(listed.status).toBe(200);
  for (const item of listed.json.items as { id: string; title: string; deletedAt: string }[]) {
    deleted.set(item.title, { id: item.id, deletedAt: Date.parse(item.deletedAt) });
  }
  expect(deleted.size).toBe(AGES.length);
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  const root = await superAdmin();
  if (projectId) {
    // Hand the project to the Super Admin first (as the APL-2522 spec does), so the person can be deactivated afterwards.
    const added = await root.c.post(`/api/projects/${projectId}/members`, { userId: root.id, role: "EDITOR" });
    expect(added.status === 201 || (added.status === 409 && /already a member/.test(added.json?.error ?? "")), JSON.stringify(added.json)).toBe(true);
    const led = await root.c.post(`/api/projects/${projectId}/leader`, { newLeaderId: root.id, previousRole: "EDITOR" });
    expect(led.status, JSON.stringify(led.json)).toBe(200);
    expect([200, 409]).toContain((await root.c.post(`/api/projects/${projectId}/archive`)).status);
  }
  if (leader) {
    const off = await root.c.post(`/api/team/${leader.id}/deactivate`, { reassign: "leaders" });
    expect(off.status === 200 || (off.status === 409 && /already deactivated/.test(off.json?.error ?? "")), JSON.stringify(off.json)).toBe(true);
  }
});

describe("qa:TC missing @APL-2720 AC1@v1.0 listTrash daysLeft at Pam's seven ages", () => {
  it.each(AGES)("qa:TC missing @APL-2720 AC1@v1.0 a task deleted $label ago has daysLeft $daysLeft", async ({ label, age, daysLeft }) => {
    const row = deleted.get(`ZZ-TEST 2720 ${label} ${RUN}`);
    expect(row, label).toBeTruthy();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(row!.deletedAt + age));
    const items = await listTrash({ id: leader.id, orgRole: "MEMBER" }, projectId);
    expect(items.find((item) => item.id === row!.id)?.daysLeft, label).toBe(daysLeft);
  });

  it("qa:TC missing @APL-2720 AC2@v1.0 the trash is still ordered by deletedAt, newest first", async () => {
    const items = await listTrash({ id: leader.id, orgRole: "MEMBER" }, projectId);
    const times = items.map((item) => new Date(item.deletedAt!).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(items).toHaveLength(AGES.length);
  });
});
