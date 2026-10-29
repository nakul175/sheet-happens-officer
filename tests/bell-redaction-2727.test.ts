import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rows: vi.fn(), count: vi.fn(), projects: vi.fn(), access: vi.fn(), activity: vi.fn(), tasks: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { notification: { findMany: mocks.rows, count: mocks.count }, project: { findMany: mocks.projects }, task: { findMany: mocks.tasks }, actionLog: { findMany: mocks.activity } } }));
vi.mock("@/lib/auth", () => ({ currentSessionId: vi.fn(), deviceLabel: vi.fn(), hashPassword: vi.fn(), verifyPassword: vi.fn() }));
vi.mock("@/lib/access", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/access")>(), projectAccess: mocks.access }));
import { HIDDEN_DEAL_TEXT, listNotifications, projectActivity } from "@/lib/feed";
const previous = process.env.CRM_VISIBLE;
const date = new Date("2026-10-28T00:00:00Z");
const note = (id: string, type: string, projectId: string | null) => ({ id, type, projectId, taskId: null, actor: { name: "ZZ-TEST private actor" }, data: { project: "ZZ-TEST secret deal", stage: "ZZ-TEST private stage" }, createdAt: date, readAt: null });
beforeEach(() => { vi.clearAllMocks(); mocks.projects.mockResolvedValue([]); mocks.count.mockResolvedValue(3); });
afterEach(() => { if (previous === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = previous; });
it.each(["MEMBER", "ADMIN", "SUPER_ADMIN"] as const)("qa:TC missing SHO-2727: off hides typed deal notices with a missing or deleted project from %s", async orgRole => {
  process.env.CRM_VISIBLE = "off";
  mocks.rows.mockResolvedValue([note("one", "DEAL_STAGE_CHANGED", null), note("two", "DEAL_STALLED", "deleted-deal"), note("three", "DEAL_NEEDS_NEXT_STEP", null)]);
  const result = await listNotifications({ id: "reader", orgRole });
  expect(result.items.map(n => ({ text: n.text, href: n.href }))).toEqual(Array.from({ length: 3 }, () => ({ text: HIDDEN_DEAL_TEXT, href: null })));
  expect(JSON.stringify(result.items)).not.toMatch(/secret deal|private stage|private actor|deleted-deal/);
});
it("qa:TC missing SHO-2727: admins hides orphan deal notices only from a Member", async () => {
  process.env.CRM_VISIBLE = "admins"; mocks.rows.mockResolvedValue([note("one", "DEAL_STAGE_CHANGED", null)]);
  expect((await listNotifications({ id: "member", orgRole: "MEMBER" })).items[0].text).toBe(HIDDEN_DEAL_TEXT);
  expect((await listNotifications({ id: "admin", orgRole: "ADMIN" })).items[0].text).toContain("ZZ-TEST secret deal");
});
it("qa:TC missing SHO-2727: all retains stored notice wording and links", async () => {
  process.env.CRM_VISIBLE = "all"; mocks.rows.mockResolvedValue([note("one", "DEAL_STAGE_CHANGED", "old-deal")]);
  const result = await listNotifications({ id: "reader", orgRole: "MEMBER" });
  expect(result.items[0].text).toContain("ZZ-TEST secret deal"); expect(result.items[0].href).toBe("/projects/old-deal");
});
it("qa:TC missing SHO-2727: ordinary task notices are not relabelled as deals", async () => {
  process.env.CRM_VISIBLE = "off"; mocks.rows.mockResolvedValue([{ ...note("one", "TASK_ASSIGNED", null), taskId: "ordinary-task", data: { title: "ZZ-TEST ordinary task" } }]);
  const result = await listNotifications({ id: "reader", orgRole: "MEMBER" });
  expect(result.items[0].text).toContain("ZZ-TEST ordinary task"); expect(result.items[0].href).toBe("/tasks/ordinary-task");
});
it("qa:TC missing SHO-2727: an unknown future DEAL notice cannot bypass hidden CRM redaction", async () => {
  process.env.CRM_VISIBLE = "off"; mocks.rows.mockResolvedValue([note("one", "DEAL_FUTURE_EVENT", null)]);
  expect((await listNotifications({ id: "reader", orgRole: "MEMBER" })).items[0]).toMatchObject({ text: HIDDEN_DEAL_TEXT, href: null });
});
it("qa:TC missing SHO-2727: unread pagination preserves its cursor and redacts every displayed page", async () => {
  process.env.CRM_VISIBLE = "off"; mocks.rows.mockResolvedValue([note("two", "DEAL_STALLED", null), note("one", "DEAL_STALLED", null)]);
  const result = await listNotifications({ id: "reader", orgRole: "MEMBER" }, { filter: "unread", before: `${date.toISOString()}|three`, limit: 1 });
  expect(mocks.rows.mock.calls[0][0]).toMatchObject({ where: { recipientId: "reader", readAt: null, OR: [{ createdAt: { lt: date } }, { createdAt: date, id: { lt: "three" } }] }, take: 2 });
  expect(result.next).toBe(`${date.toISOString()}|two`); expect(result.items[0].href).toBeNull(); expect(result.items[0].text).toBe(HIDDEN_DEAL_TEXT);
});
it("qa:TC missing SHO-2727: Activity refuses access before reading task or log details", async () => {
  mocks.access.mockRejectedValueOnce(new Error("not found"));
  await expect(projectActivity({ id: "reader", orgRole: "MEMBER" }, "hidden-deal")).rejects.toThrow("not found");
  expect(mocks.activity).not.toHaveBeenCalled(); expect(mocks.tasks).not.toHaveBeenCalled();
});
