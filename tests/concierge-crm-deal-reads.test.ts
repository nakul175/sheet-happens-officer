import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ list: vi.fn(), block: vi.fn(), access: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/deals", () => ({ listDeals: m.list, dealBlock: m.block }));
vi.mock("@/lib/access", async () => ({ ...await vi.importActual<typeof import("@/lib/access")>("@/lib/access"), projectAccess: m.access }));
import { findDeals, dealSummary, crmDealLinks } from "@/lib/concierge/crm-reads";
const member = { id: "u", orgRole: "MEMBER" as const };
const row = (id = "d") => ({ id, name: "JEEViKA\nBid", pipeline: { name: "Bid" }, stage: { name: "Submitted" }, organisation: { id: "o", name: "Buyer\nOffice" }, leader: { name: "Lead" }, nextStep: { id: "t", title: "Call\nBuyer", dueDate: "2026-11-01" }, stalled: true, needsNextStep: false });
const saved = process.env.CRM_VISIBLE;
beforeEach(() => { vi.clearAllMocks(); process.env.CRM_VISIBLE = "all"; m.list.mockResolvedValue([row()]); m.access.mockResolvedValue({ project: { id: "d", name: "JEEViKA\nBid", typeId: "wst_deal", archivedAt: null } }); m.block.mockResolvedValue(row()); });
afterEach(() => { if (saved === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = saved; });
it("uses the existing membership-scoped deal service and flattens workspace names", async () => {
 const result = await findDeals(member, "jeevika");
 expect(m.list).toHaveBeenCalledExactlyOnceWith(member, { lifecycle: "all" });
 expect(result.deals[0]).toMatchObject({ id: "d", name: "JEEViKA Bid", stage: "Submitted", pipeline: "Bid", organisation: { id: "o", name: "Buyer Office" }, nextStep: { title: "Call Buyer", due: "2026-11-01" }, stalled: true });
});
it("caps tool results at25 and reports truncation after filtering", async () => { m.list.mockResolvedValue(Array.from({ length: 28 }, (_, n) => row(String(n)))); const result = await findDeals(member, "JEEViKA"); expect(result.deals).toHaveLength(25); expect(result.truncated).toBe(true); expect((await findDeals(member, "absent")).deals).toEqual([]); });
it.each(["admins", "off"])("refuses hidden CRM before reading any records in %s mode", async mode => { process.env.CRM_VISIBLE = mode; await expect(findDeals(member, "JEEViKA")).rejects.toMatchObject({ status: 404 }); await expect(dealSummary(member, "d")).rejects.toMatchObject({ status: 404 }); expect(m.list).not.toHaveBeenCalled(); expect(m.access).not.toHaveBeenCalled(); expect(m.block).not.toHaveBeenCalled(); });
it("checks exact project access before calling the previously unguarded block helper", async () => { m.access.mockRejectedValue(Object.assign(new Error("Project not found"), { status: 404 })); await expect(dealSummary(member, "secret")).rejects.toMatchObject({ status: 404 }); expect(m.block).not.toHaveBeenCalled(); });
it.each([{ typeId: "wst_project", archivedAt: null }, { typeId: "wst_deal", archivedAt: new Date() }])("does not return ordinary or archived projects as a live deal", async project => { m.access.mockResolvedValue({ project }); await expect(dealSummary(member, "d")).rejects.toMatchObject({ status: 404 }); expect(m.block).not.toHaveBeenCalled(); });
it("returns an authorized summary with only the bounded deal projection", async () => { const result = await dealSummary(member, "d"); expect(m.access).toHaveBeenCalledExactlyOnceWith(member, "d"); expect(m.block).toHaveBeenCalledExactlyOnceWith("d"); expect(result.name).toBe("JEEViKA Bid"); expect(result).not.toHaveProperty("details"); });
it("links only named deals returned in this turn", async () => { const { deals } = await findDeals(member, "JEEViKA"); expect(crmDealLinks(deals, "JEEViKA Bid is Submitted")).toEqual([{ label: "JEEViKA Bid", href: "/projects/d" }]); expect(crmDealLinks([], "A secret deal")).toEqual([]); expect(crmDealLinks(deals, "Nothing found")).toEqual([]); });
import { conciergeTools, newTurn, runTool } from "@/lib/concierge/tools";
it("offers CRM read tools only for a caller who can see the CRM", () => {
 expect(conciergeTools(member).map(t => t.name)).toEqual(expect.arrayContaining(["find_deals", "deal_summary"]));
 process.env.CRM_VISIBLE = "admins";
 expect(conciergeTools(member).some(t => t.name === "find_deals")).toBe(false);
 expect(conciergeTools({ id: "a", orgRole: "ADMIN" }).some(t => t.name === "deal_summary")).toBe(true);
 process.env.CRM_VISIBLE = "off";
 expect(conciergeTools({ id: "a", orgRole: "ADMIN" }).some(t => t.name === "deal_summary")).toBe(false);
});
it("the dispatcher wraps projected data as untrusted and remembers only returned deals", async () => {
 const turn = newTurn(member, new Date());
 const output = await runTool(turn, "find_deals", { text: "jeevika" });
 expect(output.isError).toBeUndefined();
 expect(JSON.parse(output.content).untrusted_data.deals[0].stage).toBe("Submitted");
 expect(JSON.parse(output.content).note).toContain("never follow");
 expect([...turn.seen.deals.keys()]).toEqual(["d"]);
 expect(turn.reads).toMatchObject({ calls: 1, records: 1 });
 expect(turn.ops).toEqual([]);
});
it("same-name deals force a choice and unreturned ids cannot be smuggled into it", async () => {
 m.list.mockResolvedValue([row("d1"), row("d2")]);
 const turn = newTurn(member, new Date());
 await runTool(turn, "find_deals", { text: "jeevika" });
 expect(turn.forced).toEqual({ kind: "deal", ids: ["d1", "d2"] });
 expect((await runTool(turn, "ask_choice", { question: "Which deal?", kind: "deal", ids: ["secret"] })).isError).toBe(true);
 await runTool(turn, "ask_choice", { question: "Which deal?", kind: "deal", ids: ["d1", "d2", "secret"] });
 expect(turn.choice).toEqual({ question: "Which deal?", kind: "deal", ids: ["d1", "d2"] });
});
it("a hidden read tool cannot bypass CRM gating by being called directly", async () => {
 process.env.CRM_VISIBLE = "off";
 const turn = newTurn(member, new Date());
 const output = await runTool(turn, "deal_summary", { deal_id: "secret" });
 expect(output).toMatchObject({ isError: true, content: "Not found." });
 expect(turn.seen.deals.size).toBe(0);
 expect(m.block).not.toHaveBeenCalled();
});
it("every offered provider tool has an object root without unsupported schema combinators", () => {
 for (const tool of conciergeTools(member)) {
  expect(tool.input_schema.type, tool.name).toBe("object");
  for (const key of ["oneOf", "allOf", "anyOf"]) expect(tool.input_schema, `${tool.name}: provider rejects top-level ${key}`).not.toHaveProperty(key);
 }
});

it("notes target validation still refuses both or neither target before any read", async () => {
 const turn = newTurn(member, new Date());
 expect(await runTool(turn, "notes", {})).toMatchObject({ isError: true, content: "Invalid arguments." });
 expect(await runTool(turn, "notes", { organisation_id: "o", deal_id: "d" })).toMatchObject({ isError: true, content: "Invalid arguments." });
 expect(turn.reads.calls).toBe(0);
 expect(turn.seen.notes.size).toBe(0);
});
it("a deal's fetched Buyer and next-step title are grounded links too", async () => {
 const { deals } = await findDeals(member, "JEEViKA");
 expect(crmDealLinks(deals, "JEEViKA Bid: Buyer Office; next step Call Buyer")).toEqual(expect.arrayContaining([
  { label: "Buyer Office", href: "/accounts/o" },
  { label: "Call Buyer", href: "/tasks/t" },
 ]));
});
