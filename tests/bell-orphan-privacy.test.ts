import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/access";

const db = vi.hoisted(() => ({
  notification: { findMany: vi.fn(), count: vi.fn() },
  project: { findMany: vi.fn(), findUnique: vi.fn() },
  actionLog: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db }));
import { HIDDEN_DEAL_TEXT, listNotifications, noticeText, projectActivity } from "@/lib/feed";

const member: Actor = { id: "reader", orgRole: "MEMBER" };
const stored = (id: string, projectId: string | null, type = "DEAL_STAGE_CHANGED") => ({
  id, projectId, type, actor: { name: "Private actor" }, taskId: null,
  data: { project: "Private renewal", stage: "Secret proposal", title: "Private next step" },
  readAt: null, createdAt: new Date("2026-10-30T10:00:00Z"),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRM_VISIBLE", "admins");
  db.notification.count.mockResolvedValue(2);
  db.project.findMany.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("SHO-2727 orphan notification privacy", () => {
  it.each(["DEAL_STAGE_CHANGED", "DEAL_NEEDS_NEXT_STEP", "DEAL_STALLED"])("redacts %s without a project id or surviving project", async (type) => {
    db.notification.findMany.mockResolvedValue([stored("missing", null, type), stored("purged", "gone", type)]);
    const result = await listNotifications(member);
    expect(result.items).toHaveLength(2);
    for (const item of result.items) expect(item).toMatchObject({ text: HIDDEN_DEAL_TEXT, href: null });
    expect(JSON.stringify(result)).not.toMatch(/Private|Secret|\/projects\//);
  });

  it.each(["gone", null])("redacts generic project-naming notices whose project provenance is %s", async (projectId) => {
    db.notification.findMany.mockResolvedValue([stored("task", projectId, "TASKS_HANDED_OVER")]);
    const { items } = await listNotifications(member);
    expect(items[0].href).toBeNull();
    expect(items[0].text).not.toMatch(/Private|Secret/);
  });

  it.each([
    ["all", "MEMBER"], ["", "MEMBER"], ["admins", "ADMIN"], ["admins", "SUPER_ADMIN"],
  ] as const)("keeps stored notices for CRM-visible readers (%s/%s)", async (mode, orgRole) => {
    vi.stubEnv("CRM_VISIBLE", mode);
    const row = stored("orphan", "gone");
    db.notification.findMany.mockResolvedValue([row]);
    const { items } = await listNotifications({ ...member, orgRole });
    expect(items[0]).toMatchObject(noticeText(row));
    expect(db.project.findMany).not.toHaveBeenCalled();
  });

  it.each(["MEMBER", "ADMIN", "SUPER_ADMIN"] as const)("redacts known orphan deals with CRM off for %s", async (orgRole) => {
    vi.stubEnv("CRM_VISIBLE", "off");
    db.notification.findMany.mockResolvedValue([stored("no-id", null)]);
    expect((await listNotifications({ ...member, orgRole })).items[0]).toMatchObject({ text: HIDDEN_DEAL_TEXT, href: null });
  });

  it("keeps valid ordinary-project notices readable when CRM is hidden", async () => {
    const row = stored("ordinary", "plain", "TASK_ASSIGNED");
    db.notification.findMany.mockResolvedValue([row]);
    db.project.findMany.mockImplementation(async ({ where }) => where.typeId === "wst_deal" ? [] : [{ id: "plain", typeId: "wst_project" }]);
    expect((await listNotifications(member)).items[0]).toMatchObject(noticeText(row));
  });

  it("redacts every unread page without changing cursor, ordering or count", async () => {
    const rows = [stored("z", null), stored("y", "gone"), stored("x", "gone")];
    db.notification.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows.slice(2));
    db.notification.count.mockResolvedValue(3);
    const first = await listNotifications(member, { filter: "unread", limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["z", "y"]);
    expect(first.unread).toBe(3);
    expect(first.next).toBe("2026-10-30T10:00:00.000Z|y");
    const second = await listNotifications(member, { filter: "unread", limit: 2, before: first.next! });
    expect(second.items.map((item) => item.id)).toEqual(["x"]);
    expect(second.next).toBeNull();
    expect([...first.items, ...second.items].every((item) => item.text === HIDDEN_DEAL_TEXT && item.href === null && !item.read)).toBe(true);
    const query = db.notification.findMany.mock.calls[1][0];
    expect(query.where).toMatchObject({ recipientId: member.id, readAt: null, OR: [
      { createdAt: { lt: rows[0].createdAt } }, { createdAt: rows[0].createdAt, id: { lt: "y" } },
    ] });
  });

  it("denies hidden-deal Activity before reading its log", async () => {
    db.project.findUnique.mockResolvedValue({ id: "deal", typeId: "wst_deal", members: [{ userId: member.id, role: "LEADER" }], actionLogs: [] });
    await expect(projectActivity(member, "deal")).rejects.toMatchObject({ status: 404 });
    expect(db.actionLog.findMany).not.toHaveBeenCalled();
  });
});
