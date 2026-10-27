// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DealBoard, columnsFor, opportunityGroups, sortDeals, totals, type BoardDeal, type BoardStage } from "../src/components/DealBoard";
import { DealPanel } from "../src/components/DealPanel";
import DealsView from "../src/app/(app)/deals/DealsView";
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ children, actions }: { children: React.ReactNode; actions: React.ReactNode }) => h("div", null, actions, children), useMe: () => ({ id: "me" }) }));
const stage = (id: string, name: string, category: string, isRetired = false): BoardStage => ({ id, name, category, needsReason: false, requiredFields: [], isRetired });
const stages = [stage("leads", "Leads", "NOT_STARTED"), stage("evaluation", "Under Evaluation", "ACTIVE"), stage("go", "Go", "ACTIVE"), stage("nogo", "No-Go", "LOST"), stage("submitted", "Submitted", "ACTIVE"), stage("won", "Won", "DONE"), stage("lost", "Lost", "LOST"), stage("hold", "On Hold", "PAUSED"), stage("delivery", "Ongoing Projects", "DELIVERY")];
const retired = stage("awaiting", "Awaiting result", "ACTIVE", true);
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
    const data = path === "/api/deals/pipelines" ? { pipelines: [{ ...pipe, stages }] } : path.startsWith("/api/deals?") ? { deals: rows } : { notes: [] };
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); });

it("SHO-3043 date filter updates board, list and totals together and clears", async () => {
  await mount(h(DealsView));
  await click("Date filters");
  const select = [...document.querySelectorAll<HTMLLabelElement>("label")].find(label => label.firstChild?.textContent?.trim() === "Date basis")!.querySelector("select")!;
  await act(async () => {
    select.value = "expectedClose";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const undated = [...document.querySelectorAll<HTMLLabelElement>("label")].find(label => label.firstChild?.textContent?.trim() === "No date")!.querySelector("select")!;
  await act(async () => {
    undated.value = "exclude";
    undated.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.body.textContent).toContain("Open RFP/RFA + OTC: 0");
  expect(document.body.textContent).toContain("No matching sales deals.");
  expect(document.querySelectorAll(".dcard")).toHaveLength(0);
  await click("List");
  expect(document.querySelectorAll("tbody tr")).toHaveLength(0);
  await click("Clear timeline filter");
  expect(document.body.textContent).toContain("Open RFP/RFA + OTC: 2");
  expect(document.querySelectorAll("tbody tr")).toHaveLength(7);
});

it("SHO-3043 composes timeline with opportunity and stage", async () => {
  await mount(h(DealsView));
  const checks = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  await act(async () => {
    checks.find(input => input.parentElement?.textContent?.includes("OTC"))!.click();
    checks.find(input => input.parentElement?.textContent?.includes("On Hold"))!.click();
  });
  expect(document.querySelectorAll(".dcard")).toHaveLength(1);
  expect(document.querySelector('a[href="/projects/sales-otc"]')).not.toBeNull();
  expect(document.body.textContent).toContain("Open RFP/RFA + OTC: 1");
  await click("Only my deals");
  expect(calls.at(-1)).toContain("mine=true");
  expect(document.querySelectorAll(".dcard")).toHaveLength(1);
});

it("SHO-3134 combines multi-select values with OR within a dimension and AND across dimensions", async () => {
  await mount(h(DealsView));
  const checks = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  await act(async () => {
    checks.find(input => input.parentElement?.textContent?.includes("RFP/RFA"))!.click();
    checks.find(input => input.parentElement?.textContent?.includes("OTC"))!.click();
    checks.find(input => input.parentElement?.textContent?.includes("Leads"))!.click();
    checks.find(input => input.parentElement?.textContent?.includes("On Hold"))!.click();
  });
  expect([...document.querySelectorAll(".dcard a")].map(a => a.textContent)).toEqual(["sales-rfp", "sales-otc"]);
  await click("Clear filters");
  expect(document.querySelectorAll(".dcard")).toHaveLength(7);
});

it("SHO-3135 sorting is stable, uses canonical stage order and keeps null submission dates last", () => {
  const a = { ...deal("b", stages[1]), name: "Beta", submissionDeadline: null };
  const b = { ...deal("a", stages[0]), name: "Alpha", submissionDeadline: "2026-12-02" };
  const c = { ...deal("c", stages[0]), name: "Alpha", submissionDeadline: "2026-12-01" };
  expect(sortDeals([a, b, c], "name-asc", stages).map(item => item.id)).toEqual(["a", "c", "b"]);
  expect(sortDeals([a, b, c], "stage", stages).map(item => item.id)).toEqual(["a", "c", "b"]);
  expect(sortDeals([a, b, c], "date-asc", stages).map(item => item.id)).toEqual(["c", "a", "b"]);
  expect(sortDeals([a, b, c], "date-desc", stages).map(item => item.id)).toEqual(["a", "c", "b"]);
});

it("Bid has distinct active decisions/outcomes, sales excludes delivery, delivery has its own column", () => {
  expect(columnsFor([...stages, retired], rows, true, "sales").map(c => c.title)).toEqual(["Leads", "Under Evaluation", "Go", "No-Go", "Submitted", "Won", "Lost", "On Hold"]);
  const delivery = columnsFor(stages, rows, true, "delivery");
  expect(delivery.map(c => c.title)).toEqual(["Ongoing Projects"]);
  expect(delivery[0].deals.map(d => d.id)).toEqual(["delivery-rfp"]);
});
it("Proactive retains original grouped-tail behavior", () => {
  const proactive = [stage("new", "Potential", "NOT_STARTED"), stage("work", "Working", "ACTIVE"), stage("pause", "Paused", "PAUSED"), stage("done", "Done", "DONE"), stage("no", "Lost", "LOST")];
  expect(columnsFor(proactive, [], false, "sales").map(c => c.title)).toEqual(["Potential", "Working", "Paused / Done / Lost"]);
});
it("Undo-restored retired stage remains visible outside active board columns and is not a move target", async () => {
  const cols = columnsFor([...stages, retired], [deal("old-history", retired)], true, "sales");
  expect(cols).toHaveLength(8);
  expect(cols.some(c => c.stages.some(s => s.id === retired.id))).toBe(false);
  await mount(h(DealBoard, { stages: [...stages, retired], deals: [deal("old-history", retired)], bid: true, lifecycle: "sales", onChange: vi.fn() }));
  const legacy = document.querySelector('[aria-label="Legacy stage deals"]')!;
  expect(legacy.textContent).toContain("Awaiting result · legacy stage");
  expect(legacy.querySelector('a[href="/projects/old-history"]')).not.toBeNull();
});

it("commercial classification cannot count EOI/CV or unknown and totals never mix currencies", () => {
  const grouped = opportunityGroups(rows.filter(d => d.stage?.category !== "DELIVERY"));
  expect(grouped.map(g => g.deals.length)).toEqual([4, 2, 1]);
  expect(totals(grouped[0].deals).sums).toEqual(["USD 300", "INR 200"]);
});
it("default sales query and open commercial count exclude outcomes and delivery; other categories visible", async () => {
  await mount(h(DealsView));
  expect(calls.some(c => c.includes("lifecycle=sales"))).toBe(true);
  const summary = document.querySelector('[aria-label="Open commercial pipeline"]')!;
  expect(summary.textContent).toContain("Open RFP/RFA + OTC: 2"); expect(summary.textContent).toContain("USD 100 · INR 200");
  expect(document.querySelector('a[href="/projects/sales-eoi"]')).not.toBeNull();
  expect(document.querySelector('a[href="/projects/sales-cv"]')).not.toBeNull();
  expect(document.querySelector('a[href="/projects/sales-unclassified"]')).not.toBeNull();
  expect(document.querySelector('a[href="/projects/delivery-rfp"]')).toBeNull();
  await click("Delivery projects");
  expect(calls.some(c => c.includes("lifecycle=delivery"))).toBe(true);
  expect(document.querySelector('[aria-label="Open commercial pipeline"]')).toBeNull();
  expect(document.querySelector('a[href="/projects/delivery-rfp"]')).not.toBeNull();
  expect(document.querySelector('a[href="/projects/sales-rfp"]')).toBeNull();
});
it("deal picker preserves current retired name while offering only active stages", async () => {
  await mount(h(DealPanel, { projectId: "old", deal: { pipeline: { ...pipe, stages: [...stages, retired] }, stage: retired, stageReason: null, details: null, parties: [], organisation: null, nextStep: null, needsNextStep: false, stalled: false }, canWrite: true, onChange: vi.fn(), feed: { status: "ready", openCount: 0, tasks: [] } }));
  const group = document.querySelector('[aria-label="Stage"]')!;
  expect(group.textContent).toContain("Awaiting result · legacy stage");
  expect([...group.querySelectorAll("button")].map(b => b.textContent)).toEqual(stages.map(s => s.name));
  expect(group.querySelectorAll("button")).toHaveLength(9);
});

it("empty delivery explains Won-to-Ongoing workflow without a create-deal dead end", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input).includes("lifecycle=delivery")
    ? new Response(JSON.stringify({ deals: [] }), { headers: { "content-type": "application/json" } })
    : originalFetch(input, init));
  await mount(h(DealsView)); await click("Delivery projects");
  const empty = document.querySelector('[aria-label="No matching deals"]')!;
  expect(empty.textContent).toContain("move an existing Won deal to Ongoing Projects");
  expect(empty.textContent).not.toContain("Create");
  expect(empty.querySelector('a[href="/deals/new"]')).toBeNull();
});

it.each([true, false])("SHO-3135 selected within-stage ordering survives grouping (Bid=%s)", async bid => {
  const examples = [
    { ...deal("b", stages[0]), name: "Alpha", submissionDeadline: "2026-12-03" },
    { ...deal("a", stages[0]), name: "Zulu", submissionDeadline: "2026-12-01" },
    { ...deal("c", stages[0]), name: "Alpha", submissionDeadline: null },
    { ...deal("d", stages[0]), name: "Alpha", submissionDeadline: undefined as unknown as null },
  ];
  const expected = { "name-asc": ["b", "c", "d", "a"], "name-desc": ["a", "b", "c", "d"], "date-asc": ["a", "b", "c", "d"], "date-desc": ["b", "a", "c", "d"], stage: ["a", "b", "c", "d"] };
  for (const [sort, ids] of Object.entries(expected)) {
    const selected = sort as Parameters<typeof sortDeals>[1];
    expect(columnsFor(stages, examples, bid, "sales", selected)[0].deals.map(d => d.id)).toEqual(ids);
    await mount(h(DealBoard, { stages, deals: examples, bid, lifecycle: "sales", sort: selected, onChange: vi.fn() }));
    expect([...document.querySelectorAll('.dcol:first-child .dcard a')].map(a => a.getAttribute("href")!.split("/").at(-1))).toEqual(ids);
    act(() => root?.unmount()); root = undefined;
  }
});

it("SHO-3134 preserves legacy unknown opportunity and unavailable-stage records without changing canonical stages", async () => {
  const unknown = { ...deal("legacy-type", stages[0]), opportunityType: "LEGACY_UNKNOWN" as BoardDeal["opportunityType"] };
  const noStage = { ...deal("no-stage", stages[0]), stage: null };
  expect(opportunityGroups([unknown, noStage])[2].deals.map(d => d.id)).toEqual(["legacy-type"]);
  await mount(h(DealBoard, { stages, deals: [unknown, noStage], bid: true, lifecycle: "sales", canMove: false, onChange: vi.fn() }));
  expect(document.querySelector('[aria-label="Unassigned stage deals"] a')?.getAttribute('href')).toBe('/projects/no-stage');
  expect([...document.querySelectorAll('.dcol>header>b')].map(e => e.textContent)).toEqual(stages.filter(s => s.category !== 'DELIVERY').map(s => s.name));
  expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
});

it("SHO-3133 omits empty opportunity sections but leaves every category available in the filter", async () => {
  const old = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith('/api/deals?')
    ? new Response(JSON.stringify({deals:[deal('only-unclassified',stages[0],null)]}),{headers:{'content-type':'application/json'}})
    : old(input,init));
  await mount(h(DealsView));
  expect(document.querySelectorAll('section[aria-label$=" sales"]')).toHaveLength(1);
  expect(document.querySelector('section[aria-label="Unclassified sales"]')).not.toBeNull();
  expect(document.querySelectorAll('.deal-multi-popup input[type=checkbox]')).toHaveLength(5+stages.length);
  expect(document.querySelector('[aria-label="Open commercial pipeline"]')?.className).not.toContain('card');
});
