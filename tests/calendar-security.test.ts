import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ task: { findMany: vi.fn() }, project: { findMany: vi.fn() }, authToken: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() }, auditLog: { create: vi.fn() }, $transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: mock }));
import { consumeToken } from "@/lib/auth";
import { calendarEvents, calendarIcs, feedHash, feedRange, feedUser, issueFeed } from "@/lib/calendar";
const actor = { id: "u", orgRole: "MEMBER" as const };
beforeEach(() => { vi.clearAllMocks(); delete process.env.CRM_VISIBLE; mock.task.findMany.mockResolvedValue([]); mock.project.findMany.mockResolvedValue([]); mock.$transaction.mockImplementation(fn => fn(mock)); });
describe("calendar security", () => {
  it("checks current memberships, Trash, archive and both ownership roles", async () => {
    await calendarEvents(actor, new Date("2026-10-01"), new Date("2026-11-01"));
    expect(mock.task.findMany.mock.calls[0][0].where).toMatchObject({ deletedAt: null, project: { archivedAt: null, members: { some: { userId: "u" } } }, OR: [{assigneeId:"u"},{collaborators:{some:{userId:"u"}}}] });
    expect(mock.project.findMany.mock.calls[0][0].where).toMatchObject({ typeId:"wst_deal", archivedAt:null, members:{some:{userId:"u"}} });
  });
  it.each(["off", "admins"])("omits hidden CRM in %s mode", async mode => { process.env.CRM_VISIBLE=mode; await calendarEvents(actor,new Date(),new Date()); expect(mock.project.findMany).not.toHaveBeenCalled(); expect(mock.task.findMany.mock.calls[0][0].where.project.typeId).toEqual({not:"wst_deal"}); });
  it("hashes secrets, returns them only on issue, and audits no secret", async () => { const secret=await issueFeed(actor); expect(secret).toMatch(/^[a-f0-9]{64}$/); expect(mock.authToken.upsert.mock.calls[0][0]).toMatchObject({where:{id:"feed:u"},update:{tokenHash:feedHash(secret)}}); expect(JSON.stringify(mock.auditLog.create.mock.calls)).not.toContain(secret); expect(mock.auditLog.create.mock.calls[0][0].data.event).toBe("FEED_TOKEN_RESET"); });
  it("rejects revoked, malformed, inactive, unverified and temporary-password feeds",async()=> { expect(await feedUser("invalid")).toBeNull(); expect(mock.authToken.findUnique).not.toHaveBeenCalled(); const secret="a".repeat(64); mock.authToken.findUnique.mockResolvedValue(null); expect(await feedUser(secret)).toBeNull(); for(const user of [{deactivatedAt:new Date(),emailVerifiedAt:new Date()},{deactivatedAt:null,emailVerifiedAt:null},{deactivatedAt:null,emailVerifiedAt:new Date(),tempPasswordAt:new Date()}]) {mock.authToken.findUnique.mockResolvedValue({type:"FEED",expiresAt:null,usedAt:null,user}); expect(await feedUser(secret)).toBeNull();} });
  it.each(["VERIFY", "RESET"] as const)("keeps %s tokens expiring and single-use", async type => {
    mock.authToken.findUnique.mockResolvedValue({id:"auth",userId:"u",type,usedAt:null,expiresAt:null});
    expect(await consumeToken("secret",type)).toBeNull(); expect(mock.authToken.updateMany).not.toHaveBeenCalled();
    mock.authToken.findUnique.mockResolvedValue({id:"auth",userId:"u",type,usedAt:null,expiresAt:new Date(Date.now()+60000)});
    mock.authToken.updateMany.mockResolvedValue({count:1}); expect(await consumeToken("secret",type)).toBe("u");
    mock.authToken.updateMany.mockResolvedValue({count:0}); expect(await consumeToken("secret",type)).toBeNull();
    mock.authToken.findUnique.mockResolvedValue({id:"auth",userId:"u",type:"FEED",usedAt:null,expiresAt:null}); expect(await consumeToken("secret",type)).toBeNull();
  });
  it("loads active users by digest afresh for every request", async()=> {const user={...actor,emailVerifiedAt:new Date(),deactivatedAt:null}; mock.authToken.findUnique.mockResolvedValue({type:"FEED",expiresAt:null,usedAt:null,user}); expect(await feedUser("b".repeat(64))).toEqual(user); expect(mock.authToken.findUnique.mock.calls[0][0].where.tokenHash).toBe(feedHash("b".repeat(64))); mock.authToken.findUnique.mockResolvedValue(null); expect(await feedUser("b".repeat(64))).toBeNull(); });
  it("uses the inclusive -90/+365 day IST window",()=>{ const r=feedRange(new Date("2026-10-28T18:31:00Z")); expect(r.from.toISOString()).toBe("2026-07-30T18:30:00.000Z"); expect(r.to.toISOString()).toBe("2027-10-29T18:30:00.000Z"); });
  it("emits all-day RFC5545 events, escaped and UTF8 folded, with only titles and links",()=>{const text=calendarIcs([{id:"t",title:"ह".repeat(50)+"\nDESCRIPTION:private,;",date:"2026-12-31",href:"/tasks/t",projectId:"p",projectName:"private project",kind:"task",updatedAt:"2026-01-01"}],"https://example.org",new Date("2026-01-01Z")); expect(text).toContain("DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101"); expect(text).toContain("URL:https://example.org/tasks/t"); expect(text).not.toMatch(/\r\nDESCRIPTION:/); expect(text).not.toContain("private project"); expect(text).not.toContain("VALARM"); for(const line of text.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75); });
});
