import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: { $queryRaw: vi.fn() } }));
import { db } from "@/lib/db";
import { contactDuplicate, dealDuplicate, duplicateThreshold, duplicateWarning, organisationDuplicate } from "@/lib/duplicates";
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
