// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DealPanel, type DealBlock } from "../src/components/DealPanel";
import NewDeal from "../src/app/(app)/deals/new/NewDeal";
import { ConvertDialog } from "../src/components/ConvertDialog";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation, useSearchParams: () => new URLSearchParams() }));
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ children }: { children: React.ReactNode }) => h("div", null, children), useMe: () => ({ id: "me" }) }));
const deal: DealBlock = {
  pipeline: { id: "pipe", key: "DEAL_BID", name: "Bid", stages: [] }, stage: null, stageReason: null,
  details: { whyPursue: "Test", need: null, serviceLine: null, value: null, currency: null, probability: 45, expectedClose: null, introducedBy: null, submissionDeadline: "2026-12-01", opportunityType: "EOI", netFeeRevenueUsd: 0, athenaEntity: "TOLADATA" },
  parties: [], organisation: null, nextStep: null, needsNextStep: false, stalled: false,
};
let root: Root;
let writes: { path: string; body: Record<string, unknown> }[];
let reject = false;
const changed = vi.fn();
const field = (label: string) => {
  const el = [...document.querySelectorAll("label")].find(x => x.textContent === label)!;
  return document.getElementById(el.htmlFor) as HTMLInputElement | HTMLSelectElement;
};
async function fill(label: string, value: string) {
  const input = field(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function click(name: string) { await act(async () => { [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === name)!.click(); }); }
async function mount(element: React.ReactNode) { await act(async () => { root = createRoot(document.getElementById("root")!); root.render(element); }); }
async function panel() { await mount(h(DealPanel, { projectId: "deal", deal, canWrite: true, onChange: changed, feed: { status: "ready", openCount: 0, tasks: [] } })); await click("Edit details"); }
async function submit() { await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'; writes = []; reject = false; changed.mockReset(); navigation.push.mockReset();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const headers = { "content-type": "application/json" };
    if (init?.method && init.method !== "GET") {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(reject ? { error: "Review this amount." } : { status: "ok", deal: { id: "created" } }), { status: reject ? 400 : 200, headers });
    }
    const data = path === "/api/orgs" ? { organisations: [{ id: "org", name: "Test buyer" }] } : path === "/api/team" ? { people: [{ id: "me", name: "Test person" }] } : path === "/api/deals/pipelines" ? { pipelines: [{ id: "pipe", key: "DEAL_BID", name: "Bid" }] } : { notes: [] };
    return new Response(JSON.stringify(data), { headers });
  });
});
afterEach(() => { act(() => root?.unmount()); vi.restoreAllMocks(); });

it("reads canonical type, USD NFR zero, entity and existing PWin, without conflating unknown with zero", async () => {
  await panel();
  expect(field("Opportunity type").value).toBe("EOI");
  expect(field("Net Fee Revenue (USD)").value).toBe("0");
  expect(field("Athena Entity").value).toBe("TOLADATA");
  expect(field("PWin (%)").value).toBe("45");
  expect(document.body.textContent).toContain("Net Fee Revenue: USD 0");
  expect(document.body.textContent).toContain("PWin: 45%");
  expect([...field("Opportunity type").querySelectorAll("option")].map(x => x.textContent)).toEqual(["Unclassified", "RFP/RFA", "EOI", "OTC", "CV/LTA"]);
  expect(field("Athena Entity").querySelectorAll("option")).toHaveLength(8);
});
it("edits classification and amount via existing deal endpoint, reuses probability without PWin duplicate", async () => {
  await panel(); await fill("Opportunity type", "OTC"); await fill("Net Fee Revenue (USD)", "1234.56"); await fill("Athena Entity", "ATHENA_INDIA"); await fill("PWin (%)", "65"); await submit();
  expect(writes[0].path).toBe("/api/projects/deal/deal");
  expect(writes[0].body).toMatchObject({ opportunityType: "OTC", netFeeRevenueUsd: 1234.56, athenaEntity: "ATHENA_INDIA", probability: 65 });
  expect(writes[0].body).not.toHaveProperty("pwin"); expect(changed).toHaveBeenCalledOnce();
});
it("clears optional fields to null and preserves error inputs on server rejection", async () => {
  reject = true; await panel(); await fill("Opportunity type", ""); await fill("Net Fee Revenue (USD)", ""); await fill("Athena Entity", ""); await submit();
  expect(writes[0].body).toMatchObject({ opportunityType: null, netFeeRevenueUsd: null, athenaEntity: null });
  expect(field("Net Fee Revenue (USD)").value).toBe(""); expect(document.querySelector('[role="alert"]')?.textContent).toBe("Review this amount."); expect(changed).not.toHaveBeenCalled();
});
it("create captures same canonical fields, keeps blanks optional, and applies USD cents bounds", async () => {
  await mount(h(NewDeal));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await fill("Client / Buyer", "Test buyer"); await fill("Opportunity type", "RFP_RFA"); await fill("Net Fee Revenue (USD)", "25.01"); await fill("Athena Entity", "APLYD_INDIA"); await fill("PWin (%)", "0");
  const amount = field("Net Fee Revenue (USD)") as HTMLInputElement;
  expect(amount.min).toBe("0"); expect(amount.step).toBe("0.01"); expect(amount.required).toBe(false);
  await submit();
  const create = writes.find((write) => write.path === "/api/deals");
  expect(create?.body).toMatchObject({ organisationId: "org", opportunityType: "RFP_RFA", netFeeRevenueUsd: 25.01, athenaEntity: "APLYD_INDIA", probability: 0 });
});
it("task conversion includes classification and rejects NFR over two decimals before request", async () => {
  await mount(h(ConvertDialog, { task: { id: "task", title: "Test", dueDate: "2026-12-01", assignee: { id: "me" } }, meId: "me", onClose: vi.fn() }));
  await fill("Organisation (buyer)", "org"); await fill("Why are we pursuing this?", "Test reason"); await fill("Submission deadline", "2026-12-01"); await fill("Opportunity type", "CV_LTA"); await fill("Athena Entity", "ATHENA_UK"); await fill("PWin (%)", "100"); await fill("Net Fee Revenue (USD)", "1.234"); await click("Convert to deal");
  expect(writes).toHaveLength(0); expect(document.querySelector('[role="alert"]')?.textContent).toContain("two decimal");
  await fill("Net Fee Revenue (USD)", "1.23"); await click("Convert to deal");
  expect(writes[0]).toMatchObject({ path: "/api/tasks/task/convert", body: { opportunityType: "CV_LTA", netFeeRevenueUsd: 1.23, athenaEntity: "ATHENA_UK", probability: 100 } });
});

it("details Save retains shared sheet footer structure and native amount validation", async () => {
  await panel();
  expect(document.querySelector('[role="dialog"] > .actions button[form]')?.textContent).toBe("Save");
  await fill("Net Fee Revenue (USD)", "-1");
  expect((field("Net Fee Revenue (USD)") as HTMLInputElement).checkValidity()).toBe(false);
  await click("Save"); expect(writes).toHaveLength(0);
  await fill("Net Fee Revenue (USD)", "1.234");
  expect((field("Net Fee Revenue (USD)") as HTMLInputElement).checkValidity()).toBe(false);
  await click("Save"); expect(writes).toHaveLength(0);
  await fill("Net Fee Revenue (USD)", "1.23"); await click("Save");
  expect(writes[0].body.netFeeRevenueUsd).toBe(1.23);
});
