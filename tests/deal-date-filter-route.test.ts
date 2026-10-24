import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";
import { GET } from "@/app/api/deals/route";

const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/auth", () => ({ currentUser: mocks.user }));
vi.mock("@/lib/deals", () => ({ listDeals: mocks.list, createDeal: vi.fn() }));

beforeEach(() => { mocks.user.mockReset().mockResolvedValue({ id: "member", orgRole: "MEMBER" }); mocks.list.mockReset().mockResolvedValue([]); });

describe("SHO3043 date-filter API validation",()=>{
 it("passes explicit validated basis/range with unchanged access/lifecycle options",async()=>{
  const response=await GET(new Request("http://localhost/api/deals?lifecycle=delivery&mine=true&dateBasis=submissionDeadline&dateFrom=2026-10-25&dateTo=2026-10-26&includeUndated=true"));expect(response.status).toBe(200);expect(mocks.list).toHaveBeenCalledWith({id:"member",orgRole:"MEMBER"},{lifecycle:"delivery",mine:true,archived:false,pipelineId:undefined,dateFilter:{basis:"submissionDeadline",from:"2026-10-25",to:"2026-10-26",includeUndated:true}});
 });
 it.each(["dateBasis=other&dateFrom=2026-10-25","dateFrom=2026-10-25","dateBasis=createdAt&dateFrom=2026-02-29","dateBasis=expectedClose&dateFrom=2026-10-26&dateTo=2026-10-25","dateBasis=submissionDeadline&dateFrom=2026-10-25&includeUndated=maybe"])("returns400 rather than broadening invalid query %s",async query=>{const response=await GET(new Request("http://localhost/api/deals?"+query));expect(response.status).toBe(400);expect(mocks.list).not.toHaveBeenCalled();});
 it("authenticates before processing malformed dates",async()=>{mocks.user.mockRejectedValue(new ApiError(401,"Sign in first."));expect((await GET(new Request("http://localhost/api/deals?dateFrom=no"))).status).toBe(401);expect(mocks.list).not.toHaveBeenCalled();});
});
