import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ranked: vi.fn(), user: vi.fn(), projects: vi.fn(), tasks: vi.fn(), organisations: vi.fn(), contacts: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {
  user: { findUniqueOrThrow: mocks.user }, project: { findMany: mocks.projects }, task: { findMany: mocks.tasks },
  organisation: { findMany: mocks.organisations }, contact: { findMany: mocks.contacts },
} }));
vi.mock("@/lib/search-query", () => ({ rankedSearch: mocks.ranked }));
import { search } from "@/lib/search";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SEARCH_STAGE_A_ENABLED", "");
  vi.stubEnv("CRM_VISIBLE", "all");
  vi.stubEnv("FF_TASK_COMMENTS", "false");
  mocks.user.mockResolvedValue({ workspaceId: "ws" });
  for (const fn of [mocks.projects, mocks.tasks, mocks.organisations, mocks.contacts]) fn.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("SHO-2587 reviewed activation boundary", () => {
  it("keeps existing search without invoking extension-dependent SQL by default", async () => {
    for (const flag of ["", "false", "1"]) {
      vi.stubEnv("SEARCH_STAGE_A_ENABLED", flag);
      await search({ id: "me", orgRole: "MEMBER" }, "budget", false);
    }
    expect(mocks.ranked).not.toHaveBeenCalled();
    expect(mocks.tasks).toHaveBeenCalledTimes(3);
  });
  it("returns the shared ranked payload only when explicitly activated", async () => {
    vi.stubEnv("SEARCH_STAGE_A_ENABLED", "true");
    const hits = [{ id: "n1", type: "NOTE", title: "Client", href: "/accounts/o1", matchedField: "note", excerpt: "revised budget", score: 3000 }];
    mocks.ranked.mockResolvedValue(hits);
    expect(await search({ id: "me", orgRole: "MEMBER" }, "revised budget", true, true)).toEqual({ hits, tasks: [], projects: [], organisations: [], contacts: [] });
    expect(mocks.ranked).toHaveBeenCalledWith({ id: "me", orgRole: "MEMBER" }, "revised budget", { archived: true, ideasOnly: true });
    expect(mocks.tasks).not.toHaveBeenCalled();
  });
  it("reports an activated-query failure rather than disguising it as no results", async () => {
    vi.stubEnv("SEARCH_STAGE_A_ENABLED", "true");
    mocks.ranked.mockRejectedValueOnce(new Error("extension unavailable"));
    await expect(search({ id: "me", orgRole: "MEMBER" }, "budget", false)).rejects.toThrow("extension unavailable");
    expect(mocks.tasks).not.toHaveBeenCalled();
  });
});
