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
import ReviewView from "../src/app/(app)/review/ReviewView";

let root: Root | undefined;
const row = (id: string, opportunityType: string | null, opts: { stage?: string; category?: string; value?: number | null; currency?: string | null; deadline?: string | null } = {}) => ({
  id, name: id, archived: false, opportunityType,
  stage: { id: opts.stage ?? "lead", name: opts.stage ?? "Lead", category: opts.category ?? "ACTIVE" },
  value: opts.value === undefined ? 100 : opts.value, currency: opts.currency === undefined ? "USD" : opts.currency,
  submissionDeadline: opts.deadline === undefined ? "2026-11-10" : opts.deadline,
  needsNextStep: true, stalled: true, lastActivity: "2026-01-01", pipeline: { name: "Bid" }, organisation: null, leader: null, nextStep: null,
});

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-26T00:00:00.000+05:30"));
  vi.resetAllMocks(); document.body.innerHTML = '<div id="root"></div>';
  fake.db.task.findMany.mockResolvedValue([]);
  fake.db.pipeline.findMany.mockResolvedValue([{ id: "bid", name: "Bid", stages: [
    { id: "lead", name: "Lead", category: "ACTIVE" },
    { id: "hold", name: "On hold", category: "PAUSED" },
    { id: "won", name: "Won", category: "DONE" },
    { id: "lost", name: "Lost", category: "LOST" },
  ] }]);
  fake.deals.mockResolvedValue([
    row("rfp", "RFP_RFA"),
    row("otc-hold", "OTC", { stage: "hold", category: "PAUSED", value: 200, currency: "INR" }),
    row("rfp-won", "RFP_RFA", { stage: "won", category: "DONE", value: 300, deadline: "2026-11-20" }),
    row("otc-lost", "OTC", { stage: "lost", category: "LOST", deadline: "2026-10-01" }),
    row("eoi", "EOI"), row("cv", "CV_LTA", { value: null }), row("legacy", null),
  ]);
});

afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

it("separates canonical commercial, other and unclassified deals with per-currency totals", async () => {
  const result = await pipelineReview({ id: "me", orgRole: "MEMBER" });
  expect(result.counts[0].stages.find(s => s.id === "lead")).toMatchObject({ count: 1, sums: [{ currency: "USD", total: 100 }] });
  expect(result.counts[0].stages.find(s => s.id === "hold")).toMatchObject({ count: 1, sums: [{ currency: "INR", total: 200 }] });
  expect(result.otherCounts[0].stages.find(s => s.id === "lead")).toMatchObject({ count: 2, withoutValue: 1 });
  expect(result.unclassifiedCounts[0].stages.find(s => s.id === "lead")).toMatchObject({ count: 1 });
  expect(result.openCommercialCount).toBe(2);
  expect(result.headlineRule).toContain("On hold");
  expect(result.headlineRule).toContain("Won, Lost and Ongoing/Delivery");
});

it("applies explicit deadline timelines without hiding missing types in the all view", async () => {
  const next30 = await pipelineReview({ id: "me", orgRole: "MEMBER" }, "30d");
  expect(next30.counts[0].stages.find(s => s.id === "lead")?.count).toBe(1);
  expect(next30.counts[0].stages.find(s => s.id === "won")?.count).toBe(1);
  expect(next30.counts[0].stages.find(s => s.id === "lost")?.count).toBe(0);
  const overdue = await pipelineReview({ id: "me", orgRole: "MEMBER" }, "overdue");
  expect(overdue.counts[0].stages.find(s => s.id === "lost")?.count).toBe(1);
  expect(overdue.openCommercialCount).toBe(0);
});

it("renders labelled categories, timeline control and the agreed headline rule", async () => {
  const result = await pipelineReview({ id: "me", orgRole: "MEMBER" });
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } }));
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(ReviewView)); });
  expect(document.querySelector('[aria-label="Commercial pipeline by stage · RFP/RFA + OTC"]')?.textContent).toContain("USD 100");
  expect(document.querySelector('[aria-label="Other opportunities by stage · EOI + CV/LTA"]')?.textContent).toContain("1 without value");
  expect(document.querySelector('[aria-label^="Unclassified opportunities"]')?.textContent).toContain("not included");
  expect(document.querySelector<HTMLSelectElement>("#review-timeline")?.value).toBe("all");
  expect(document.body.textContent).toContain("Open commercial · 2");
});
