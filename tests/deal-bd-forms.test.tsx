// @vitest-environment jsdom
// Client payload/error checks only; database persistence is a separate required gate.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn(), changed: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: harness.push }), useSearchParams: () => new URLSearchParams("org=buyer") }));
vi.mock("@/app/(app)/Shell", () => ({ useMe: () => ({ id: "leader" }), Page: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/api", () => ({
  api: harness.api, todayIST: () => "2026-10-31", dueLabel: (date: string) => date, isOverdue: () => false,
  useGet: (url: string | null) => ({ loading: false, error: null, reload: vi.fn(), data: !url ? null : url.includes("/pipelines")
    ? { pipelines: [{ id: "pro", key: "DEAL_PROACTIVE", name: "Proactive" }] }
    : url === "/api/team" ? { people: [{ id: "leader", name: "Leader" }] }
    : url === "/api/orgs" ? { organisations: [{ id: "buyer", name: "Buyer" }] } : { notes: [] } }),
}));
vi.mock("@/components/PeopleSelect", () => ({ PeopleSelect: ({ id }: { id: string }) => <select id={id}><option>Leader</option></select> }));
import NewDeal from "@/app/(app)/deals/new/NewDeal";
import { DealPanel, type DealBlock } from "@/components/DealPanel";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  harness.api.mockResolvedValue({ ok: true, data: { deal: { id: "created" } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(node: ReactNode) { await act(async () => root.render(node)); }
function field(label: string) {
  const control = [...document.querySelectorAll("label")].find((l) => l.textContent?.trim() === label)?.control;
  expect(control, label).toBeTruthy();
  return control as HTMLInputElement | HTMLSelectElement;
}
async function fill(label: string, value: string) {
  const input = field(label);
  const select = input instanceof HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(select ? "change" : "input", { bubbles: true }));
  });
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button, label).toBeTruthy(); await act(async () => button!.click());
}
async function submit() {
  const form = document.querySelector('form'); expect(form).toBeTruthy();
  await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
const deal: DealBlock = {
  pipeline: { id: "pro", key: "DEAL_PROACTIVE", name: "Proactive", stages: [] }, stage: null, stageReason: null,
  details: { whyPursue: "Fit", need: null, serviceLine: null, value: null, currency: null, probability: 50, expectedClose: null, introducedBy: null, submissionDeadline: null,
    partner: "Original", athenaRole: "PRIME", budgetUsd: 100.25, pwinAdjustedNfrUsd: 50.12 },
  parties: [], organisation: null, nextStep: null, needsNextStep: false, stalled: false,
};
const panel = () => <DealPanel projectId="deal" deal={deal} canWrite canManage onChange={harness.changed} feed={{ status: "ready", openCount: 0, tasks: [] }} />;

it("the actual create form submits numeric USD values and role codes alongside existing deal inputs", async () => {
  await render(<NewDeal />);
  await fill("Deal name", "New opportunity"); await fill("Why are we pursuing this?", "Fit"); await fill("First next step", "Call");
  await fill("Partner", "Partner Co"); await fill("Athena role", "SUB"); await fill("Budget (USD)", "1000.25"); await fill("PWin-adjusted NFR (USD)", "0");
  await submit();
  expect(harness.api).toHaveBeenCalledWith("POST", "/api/deals", expect.objectContaining({ partner: "Partner Co", athenaRole: "SUB", budgetUsd: 1000.25, pwinAdjustedNfrUsd: 0, organisationId: "buyer" }));
  expect(harness.push).toHaveBeenCalledWith("/projects/created");
});

it("the actual edit form loads values and distinguishes clearing fields from an explicit zero", async () => {
  await render(panel()); await click("Edit details");
  expect(field("Partner").value).toBe("Original"); expect(field("Athena role").value).toBe("PRIME"); expect(field("Budget (USD)").value).toBe("100.25");
  await fill("Partner", ""); await fill("Athena role", ""); await fill("Budget (USD)", "0"); await fill("PWin-adjusted NFR (USD)", "");
  await submit();
  expect(harness.api).toHaveBeenCalledWith("PATCH", "/api/projects/deal/deal", expect.objectContaining({ partner: null, athenaRole: null, budgetUsd: 0, pwinAdjustedNfrUsd: null, probability: 50 }));
  expect(harness.changed).toHaveBeenCalledTimes(1);
});

it("a rejected save keeps the entered fields and Cancel sends no second mutation", async () => {
  harness.api.mockResolvedValue({ ok: false, error: "This deal changed. Refresh it." });
  await render(panel()); await click("Edit details"); await fill("Partner", "Unsaved partner"); await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("This deal changed. Refresh it.");
  expect(field("Partner").value).toBe("Unsaved partner"); expect(harness.changed).not.toHaveBeenCalled();
  await click("Cancel"); expect(harness.api).toHaveBeenCalledTimes(1);
});
