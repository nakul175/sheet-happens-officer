// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ children, actions }: { children: React.ReactNode; actions: React.ReactNode }) => h("main", null, actions, children), useMe: () => ({ id: "me" }) }));
import { reviewQueue, type DealRow, type ReviewData } from "../src/lib/review-queue";
import ReviewView from "../src/app/(app)/review/ReviewView";
import ReportingView from "../src/app/(app)/review/reporting/ReportingView";
let root: Root | undefined;
const deal: DealRow = { id: "same", name: "Full opportunity", organisation: { id: "org", name: "Organisation" }, pipeline: "Pipeline", stage: "Discovery", leader: { name: "Leader" }, nextStep: { title: "Actual next task", dueDate: "2020-01-01" } };
const data: ReviewData = { needsNextStep: [deal, deal], overdueNextStep: [deal], stalled: [{ ...deal, lastActivity: "2020-01-01" }], ideas: [{ id: "same", title: "Separate idea", dueDate: null, createdAt: "2020-01-01", assignee: { id: "me", name: "Me" }, project: { id: "p", name: "Project" }, canEdit: false }], counts: [{ id: "pipe", name: "Pipeline", stages: [{ id: "s", name: "Stage", count: 3, sums: [{ currency: "USD", total: 100 }, { currency: "INR", total: 200 }], withoutValue: 1 }] }], otherCounts: [], unclassifiedCounts: [], timeline: "all", openCommercialCount: 3, headlineRule: "Actual commercial headline rule" };
async function mount(report = false) {
  document.body.innerHTML = '<div id="root"></div>';
  const fetcher = vi.fn(async (input: RequestInfo | URL) => { void input; return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }); }); globalThis.fetch = fetcher;
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(report ? ReportingView : ReviewView)); }); return fetcher;
}
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); });
it("deduplicates union/category counts while keeping overlapping reasons and namespaced idea identity", () => {
  const queue = reviewQueue(data);
  expect(queue.counts).toEqual({ all: 2, missing: 1, overdue: 1, inactive: 1, ideas: 1 });
  expect(queue.rows[0].key).toBe("opportunity:same");
  expect(queue.rows[0].reasons).toEqual(["overdue", "missing", "inactive"]);
  expect(queue.rows[1].key).toBe("idea:same");
  expect(queue.rows[0].deal?.lastActivity).toBe("2020-01-01");
});
it("keeps one compact queue and selected category state without unauthorized idea mutations", async () => {
  await mount();
  expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
  const ideas = [...document.querySelectorAll('button')].find(b => b.textContent!.startsWith("Ideas"))!;
  await act(async () => ideas.click()); expect(ideas.getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
  expect([...document.querySelectorAll('button')].some(b => b.textContent === "Drop")).toBe(false);
  expect(document.querySelector('a[href="/review/reporting"]')).not.toBeNull();
  expect(document.querySelector('a[href="/projects/p?task=same"]')).not.toBeNull();
});
it("reporting does not combine currencies, preserves missing value and category headline context", async () => {
  const fetcher = await mount(true);
  expect(document.querySelector('td[data-label="Value by currency"]')!.textContent).toBe("USD 100 · INR 200");
  expect(document.querySelector('td[data-label="Missing value"]')!.textContent).toBe("1");
  const other = [...document.querySelectorAll('button')].find(b => b.textContent === "Other opportunities")!;
  await act(async () => other.click());
  expect(document.body.textContent).not.toContain("Open commercial · 3");
  expect(document.body.textContent).toContain("EOI + CV/LTA");
  const timeline = document.querySelector<HTMLSelectElement>('#review-timeline')!;
  await act(async () => { timeline.value = "30d"; timeline.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("timeline=30d");
});
