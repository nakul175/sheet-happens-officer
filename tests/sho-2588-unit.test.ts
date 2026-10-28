import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: { $queryRaw: vi.fn(), project: { findUnique: vi.fn() } } }));
import { db } from "@/lib/db";
import { contactDuplicate, dealDuplicate, dealDuplicateWarning, duplicateThreshold, duplicateWarning, organisationDuplicate } from "@/lib/duplicates";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("SHO-2588 duplicate matching", () => {
  it("defaults to the agreed 0.4 threshold and rejects invalid settings", () => {
    expect(duplicateThreshold()).toBe(0.4);
    vi.stubEnv("DUPLICATE_SIMILARITY_THRESHOLD", "0.55"); expect(duplicateThreshold()).toBe(0.55);
    for (const value of ["NaN", "0", "2", "-0.1"]) { vi.stubEnv("DUPLICATE_SIMILARITY_THRESHOLD", value); expect(duplicateThreshold()).toBe(0.4); }
  });
  it("binds the workspace, near name and threshold in the organisation query", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([{ id: "org", name: "Ministry of Education" }]);
    expect((await organisationDuplicate("ws", "Ministry for Education"))?.id).toBe("org");
    const call = vi.mocked(db.$queryRaw).mock.calls[0];
    expect(call.slice(1)).toContain("ws"); expect(call.slice(1)).toContain("Ministry for Education"); expect(call.slice(1)).toContain(0.4);
    expect((call[0] as TemplateStringsArray).join("")).not.toContain('"parentId"');
  });
  it("checks contact email across organisations and name within the organisation", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([]);
    await contactDuplicate("ws", "org", "Jane Smyth", " Jane@Example.com ");
    const call = vi.mocked(db.$queryRaw).mock.calls[0];
    expect(call.slice(1)).toContain("Jane@Example.com"); expect(call.slice(1)).toContain("org");
    expect((call[0] as TemplateStringsArray).join("")).toContain(" OR ");
  });
  it("checks deals across buyers and returns an advisory confirmation", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([{ id: "deal", name: "Education reform" }]);
    const duplicate = await dealDuplicate("ws", "Education reforms");
    expect(duplicateWarning("deal", duplicate!)).toMatchObject({ status: 409 });
    expect((vi.mocked(db.$queryRaw).mock.calls[0][0] as TemplateStringsArray).join("")).not.toContain("organisationId");
  });
});

it("redacts a hidden deal while retaining identifying fields for a fresh member", async () => {
  const candidate = { id: "secret-id", name: "Secret acquisition" };
  const row = { id: candidate.id, typeId: "wst_deal", archivedAt: null, members: [{ userId: "member", role: "EDITOR" }] };
  vi.mocked(db.project.findUnique).mockResolvedValue(row as never);
  const hidden = await dealDuplicateWarning({ id: "outsider", orgRole: "MEMBER" }, candidate);
  expect(hidden).toMatchObject({ status: 409, extra: { needsConfirm: "duplicate" } });
  expect(JSON.stringify({ message: hidden.message, ...hidden.extra })).not.toContain(candidate.id);
  expect(JSON.stringify({ message: hidden.message, ...hidden.extra })).not.toContain(candidate.name);
  const visible = await dealDuplicateWarning({ id: "member", orgRole: "MEMBER" }, candidate);
  expect(visible.extra).toMatchObject({ existingId: candidate.id, existingName: candidate.name });
});
it("answers CRM-off before duplicate lookup or any database access", async () => {
  vi.stubEnv("CRM_VISIBLE", "off");
  const { createDeal } = await import("@/lib/deals");
  await expect(createDeal({ id: "outsider", orgRole: "MEMBER" }, {} as never)).rejects.toMatchObject({ status: 404 });
  expect(db.$queryRaw).not.toHaveBeenCalled();
  expect(db.project.findUnique).not.toHaveBeenCalled();
});
