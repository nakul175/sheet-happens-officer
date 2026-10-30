import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), query: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { user: { findUniqueOrThrow: mocks.actor }, $transaction: mocks.transaction } }));
import { rankedSearch } from "@/lib/search-query";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRM_VISIBLE", "all");
  mocks.actor.mockResolvedValue({ workspaceId: "ws-owned", orgRole: "MEMBER", deactivatedAt: null });
  mocks.query.mockResolvedValue([]);
  mocks.transaction.mockImplementation((fn) => fn({ $queryRaw: mocks.query }));
});
afterEach(() => vi.unstubAllEnvs());

describe("SHO-2587 query security and shared result contract", () => {
  it("re-reads authority and binds user text, workspace and membership instead of interpolating SQL", async () => {
    const query = "budget'; DROP TABLE users --";
    await rankedSearch({ id: "member", orgRole: "SUPER_ADMIN" }, query);
    expect(mocks.actor).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "member" } }));
    const sql = mocks.query.mock.calls[1][0];
    expect(sql.text).not.toContain(query);
    expect(sql.values).toContain(query);
    expect(sql.values).toContain("ws-owned");
    expect(sql.values).toContain("member");
    expect(sql.text).toContain('"ProjectMember"');
    expect(sql.text).toContain('"deletedAt" IS NULL');
    expect(sql.text).toContain('"removedAt" IS NULL');
    expect(sql.text).not.toContain('"ChatMessage"');
    expect(sql.text).not.toContain('"Comment"');
    expect(sql.values.at(-1)).toBe(25);
  });
  it("excludes every CRM source when CRM is hidden and keeps task project restrictions", async () => {
    vi.stubEnv("CRM_VISIBLE", "off");
    await rankedSearch({ id: "member", orgRole: "MEMBER" }, "budgets", { tasksOnly: true, projectId: "project-one", includeDone: false });
    const sql = mocks.query.mock.calls[1][0];
    expect(sql.text).not.toContain('FROM "Note"');
    expect(sql.text).not.toContain('FROM "Organisation"');
    expect(sql.text).toContain("'wst_deal'");
    expect(sql.values).toContain("project-one");
    expect(sql.text).toContain('"completedAt" IS NULL');
  });
  it("returns only current query rows and turns stored markup into a bounded plain-text excerpt", async () => {
    mocks.query.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "note-1", type: "NOTE", title: "Client", href: "/accounts/org-1", matchedField: "note", document: "<b>Revised budget</b>", score: 1000 },
    ]);
    expect(await rankedSearch({ id: "member", orgRole: "MEMBER" }, "budget")).toEqual([
      { id: "note-1", type: "NOTE", title: "Client", href: "/accounts/org-1", matchedField: "note", excerpt: "Revised budget", score: 1000 },
    ]);
  });
  it("does not query search data for a deactivated actor or an empty query; propagates DB failure", async () => {
    expect(await rankedSearch({ id: "member", orgRole: "MEMBER" }, "x")).toEqual([]);
    mocks.actor.mockResolvedValueOnce({ workspaceId: "ws", orgRole: "MEMBER", deactivatedAt: new Date() });
    expect(await rankedSearch({ id: "member", orgRole: "MEMBER" }, "budget")).toEqual([]);
    expect(mocks.transaction).not.toHaveBeenCalled();
    mocks.transaction.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(rankedSearch({ id: "member", orgRole: "MEMBER" }, "budget")).rejects.toThrow("database unavailable");
  });
});
