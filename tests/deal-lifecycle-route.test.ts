import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";
import { GET } from "@/app/api/deals/route";

const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user }));
vi.mock("@/lib/deals", () => ({ listDeals: mocks.list, createDeal: vi.fn() }));

beforeEach(() => { mocks.user.mockReset().mockResolvedValue({ id: "member", orgRole: "MEMBER" }); mocks.list.mockReset().mockResolvedValue([]); });
describe("deal sales/delivery API boundary", () => {
  it.each(["sales", "delivery", "all"])("passes explicit %s scope with existing visibility filters", async (lifecycle) => {
    const r = await GET(new Request(`http://localhost/api/deals?lifecycle=${lifecycle}&mine=true&archived=true&pipelineId=bid`));
    expect(r.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ id: "member", orgRole: "MEMBER" }, { lifecycle, mine: true, archived: true, pipelineId: "bid" });
  });
  it("keeps the existing all-deals API default for callers that omit the scope", async () => {
    expect((await GET(new Request("http://localhost/api/deals"))).status).toBe(200);
    expect(mocks.list.mock.calls[0][1].lifecycle).toBe("all");
  });
  it("refuses unknown scope rather than silently broadening results", async () => {
    expect((await GET(new Request("http://localhost/api/deals?lifecycle=secret"))).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("authenticates before validating or querying the lifecycle", async () => {
    mocks.user.mockRejectedValue(new ApiError(401, "Sign in first."));
    expect((await GET(new Request("http://localhost/api/deals?lifecycle=secret"))).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
