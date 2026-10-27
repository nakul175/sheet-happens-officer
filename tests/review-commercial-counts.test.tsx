// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ deals: vi.fn(), db: { task: { findMany: vi.fn() }, pipeline: { findMany: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/deals", () => ({ listDeals: fake.deals }));
vi.mock("@/lib/crm", () => ({ WORKSTREAM_DEAL: "wst_deal", crmVisible: () => true, requireCrm: () => {} }));
vi.mock("@/lib/access", () => ({ isAdmin: () => false }));
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ children }: { children: React.ReactNode }) => h("div", null, children), useMe: () => ({ id: "me" }) }));
import { pipelineReview } from "../src/lib/review";
import ReportingView from "../src/app/(app)/review/reporting/ReportingView";
import ReviewView from "../src/app/(app)/review/ReviewView";
let root: Root | undefined;
const row = (id: string, opportunityType: string | null, stageId = "lead", value: number | null = 100, currency = "USD") => ({ id, name: id, archived: false, opportunityType, stage: { id: stageId, name: stageId, category: "ACTIVE" }, value, currency, needsNextStep: true, stalled: true, lastActivity: "2026-01-01", pipeline: { name: "Proactive" }, organisation: null, leader: null, nextStep: null });
beforeEach(() => {
  vi.resetAllMocks(); document.body.innerHTML = '<div id="root"></div>';
  fake.db.task.findMany.mockResolvedValue([]);
  fake.db.pipeline.findMany.mockResolvedValue([{ id: "pro", name: "Proactive", stages: [{ id: "lead", name: "Lead", category: "ACTIVE" }] }, { id: "bid", name: "Bid", stages: [{ id: "submitted", name: "Submitted", category: "ACTIVE" }] }]);
  fake.deals.mockResolvedValue([row("rfp", "RFP_RFA"), row("otc", "OTC", "lead", 200, "INR"), row("eoi", "EOI"), row("cv", "CV_LTA", "submitted", null), row("legacy", null), row("unknown-value-rfp", "RFP_RFA", "lead", null)]);
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); });
it("separates commercial, EOI/CV and unclassified stage counts without changing operational queues or currencies", async () => {
  const result = await pipelineReview({ id: "me", orgRole: "MEMBER" });
  expect(fake.deals).toHaveBeenCalledWith({ id: "me", orgRole: "MEMBER" }, { lifecycle: "sales" });
  expect(result.counts[0].stages[0]).toMatchObject({ name: "Lead", count: 3, sums: [{ currency: "USD", total: 100 }, { currency: "INR", total: 200 }], withoutValue: 1 });
  expect(result.otherCounts[0].stages[0]).toMatchObject({ count: 1, sums: [{ currency: "USD", total: 100 }] });
  expect(result.otherCounts[1].stages[0]).toMatchObject({ name: "Submitted", count: 1, sums: [], withoutValue: 1 });
  expect(result.unclassifiedCounts[0].stages[0]).toMatchObject({ count: 1, sums: [{ currency: "USD", total: 100 }] });
  expect(result.needsNextStep.map(d => d.id)).toEqual(["rfp", "otc", "eoi", "cv", "legacy", "unknown-value-rfp"]);
  expect(result.stalled.map(d => d.id)).toEqual(["rfp", "otc", "eoi", "cv", "legacy", "unknown-value-rfp"]);
  expect(fake.db.pipeline.findMany).toHaveBeenCalledWith(expect.objectContaining({ include: { stages: { where: { isRetired: false, category: { not: "DELIVERY" } }, orderBy: { position: "asc" } } } }));
});
it("reporting keeps all three category data sets reachable with separate currencies and missing values", async () => {
  const result = await pipelineReview({ id: "me", orgRole: "MEMBER" });
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } }));
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(ReportingView)); });
  const commercial = document.querySelector('[aria-label="Commercial pipeline by stage · RFP/RFA + OTC"]')!;
  expect(commercial.textContent).toContain("USD 100 · INR 200");
  expect(commercial.querySelector('td[data-label="Missing value"]')!.textContent).toBe("1");
  await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === "Other opportunities")!.click());
  const other = document.querySelector('[aria-label="Other opportunities by stage · EOI + CV/LTA"]')!;
  expect(other.textContent).toContain("Submitted"); expect(other.textContent).toContain("1 opportunity has no recorded value");
  await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === "Unclassified")!.click());
  expect(document.querySelector('[aria-label^="Unclassified opportunities"]')!.textContent).toContain("Lead1USD 100");
  await act(async () => root!.render(h(ReviewView)));
  expect(document.querySelector('[aria-label="Review queue"]')!.textContent).toContain("eoi");
});
