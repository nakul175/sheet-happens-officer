// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type BoardDeal, type BoardStage } from "../src/components/DealBoard";
import DealsView from "../src/app/(app)/deals/DealsView";
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ children, actions }: { children: React.ReactNode; actions: React.ReactNode }) => h("div", null, actions, children), useMe: () => ({ id: "me" }) }));
const stage = (id: string, name: string, category: string, isRetired = false): BoardStage => ({ id, name, category, needsReason: false, requiredFields: [], isRetired });
const stages = [stage("leads", "Leads", "NOT_STARTED"), stage("evaluation", "Under Evaluation", "ACTIVE"), stage("go", "Go", "ACTIVE"), stage("nogo", "No-Go", "LOST"), stage("submitted", "Submitted", "ACTIVE"), stage("won", "Won", "DONE"), stage("lost", "Lost", "LOST"), stage("hold", "On Hold", "PAUSED"), stage("delivery", "Ongoing Projects", "DELIVERY")];
const pipe = { id: "bid", key: "DEAL_BID", name: "Bid" };
function deal(id: string, s: BoardStage, type: BoardDeal["opportunityType"] = "RFP_RFA", value = 100, currency = "USD"): BoardDeal {
  return { id, name: id, archived: false, pipeline: pipe, stage: s, organisation: null, leader: null, value, currency, opportunityType: type, submissionDeadline: "2026-12-01", nextStep: null, needsNextStep: false, stalled: false };
}
const rows = [deal("sales-rfp", stages[0]), deal("sales-otc", stages[7], "OTC", 200, "INR"), deal("won-rfp", stages[5]), deal("nogo-otc", stages[3], "OTC"), deal("sales-eoi", stages[1], "EOI"), deal("sales-cv", stages[1], "CV_LTA"), deal("sales-unclassified", stages[1], null), deal("delivery-rfp", stages[8])];
let root: Root | undefined;
let calls: string[];
async function mount(element: React.ReactNode) { await act(async () => { root = createRoot(document.getElementById("root")!); root.render(element); }); }
async function click(label: string) { await act(async () => { [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!.click(); }); }
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'; calls = [];
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input); calls.push(path);
    const data = path === "/api/deals/pipelines" ? { pipelines: [{ ...pipe, stages }] } : path.startsWith("/api/deals?") ? { deals: path.includes("dateBasis=") ? rows.filter(row => row.id === "sales-rfp") : rows } : { notes: [] };
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); });


it("Deals counts and groups follow filtered server rows, and Clear restores the original results",async()=>{
 await mount(h(DealsView));expect(document.querySelector('[aria-label="Open commercial pipeline"]')?.textContent).toContain("RFP/RFA + OTC: 2");expect(document.querySelector('[aria-label="Open commercial pipeline"]')?.textContent).toContain("INR 200");
 const select=document.querySelector<HTMLSelectElement>('[aria-label="Date basis"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(select,"submissionDeadline");select.dispatchEvent(new Event("change",{bubbles:true}));});
 const from=document.querySelector<HTMLInputElement>('[aria-label="From date (IST, inclusive)"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(from,"2026-10-25");from.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>{document.querySelector('[aria-label="Deal date filter"] form')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
 expect(calls.some(call=>call.includes("dateBasis=submissionDeadline")&&call.includes("dateFrom=2026-10-25")&&call.includes("lifecycle=sales"))).toBe(true);
 expect(document.querySelector('[aria-label="Open commercial pipeline"]')?.textContent).toContain("RFP/RFA + OTC: 1");expect(document.querySelector('[aria-label="Open commercial pipeline"]')?.textContent).not.toContain("INR 200");expect(document.querySelector('a[href="/projects/sales-eoi"]')).toBeNull();
 await click("Clear date filter");expect(document.querySelector('[aria-label="Open commercial pipeline"]')?.textContent).toContain("RFP/RFA + OTC: 2");expect(document.querySelector('a[href="/projects/sales-eoi"]')).not.toBeNull();expect(calls.filter(call=>call.startsWith("/api/deals?")).at(-1)).not.toContain("dateBasis");
});
