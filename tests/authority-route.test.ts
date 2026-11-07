import { beforeEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({currentUser:vi.fn(),findMany:vi.fn()}));
vi.mock("@/lib/auth",()=>({currentUser:mocks.currentUser}));
vi.mock("@/lib/db",()=>({db:{projectMember:{findMany:mocks.findMany}}}));
vi.mock("next/server",()=>({connection:async()=>{}}));
import { GET } from "@/app/api/auth/authority/route";
import { ApiError } from "@/lib/http";
beforeEach(()=>{vi.resetAllMocks();mocks.currentUser.mockResolvedValue({id:"target",workspaceId:"fixture",orgRole:"MEMBER"});mocks.findMany.mockResolvedValue([]);});
it("returns only an uncached current-user revision and observes grant downgrade revoke",async()=>{
 const hashes=[];
 for(const role of [null,"LEADER","VIEWER",null]){
  mocks.findMany.mockResolvedValue(role?[{projectId:"fixture",role}]:[]);
  const r=await GET();expect(r.headers.get("cache-control")).toBe("private, no-store");
  const body=await r.json();expect(Object.keys(body)).toEqual(["revision"]);hashes.push(body.revision);
 }
 expect(new Set(hashes).size).toBe(3);expect(hashes[0]).toBe(hashes[3]);
 expect(mocks.findMany.mock.calls.every(([arg])=>arg.where.userId==="target")).toBe(true);
});
it("organisation authority also invalidates project UI",async()=>{
 const before=(await (await GET()).json()).revision;
 mocks.currentUser.mockResolvedValue({id:"target",workspaceId:"fixture",orgRole:"ADMIN"});
 expect((await (await GET()).json()).revision).not.toBe(before);
});
it("missing/disabled session cannot read the revision or any membership",async()=>{
 mocks.currentUser.mockRejectedValue(new ApiError(401,"Not signed in"));
 expect((await GET()).status).toBe(401);expect(mocks.findMany).not.toHaveBeenCalled();
});
