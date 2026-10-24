// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ConvertDealToBid } from "@/components/ConvertDealToBid";
import { DealPanel, type DealBlock } from "@/components/DealPanel";
const m = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/components/api", () => ({ api: m.api, useGet: () => ({ data: { organisations: [], notes: [] }, loading: false }), dueLabel: (v: string) => v, isOverdue: () => false }));
vi.mock("@/components/ui", async () => {
  const React = await import("react");
  return { Modal: ({ children, label }: { children: React.ReactNode; label: string }) => <div role="dialog" aria-label={label}>{children}</div>, Field: ({ label, children }: { label: string; children: (id: string) => React.ReactNode }) => { const id = React.useId(); return <label htmlFor={id}>{label}{children(id)}</label>; } };
});
let root: Root;
const done = vi.fn(), close = vi.fn();
async function mount(deadline: string | null = null) { await act(async () => root.render(<ConvertDealToBid projectId="deal" pipelineId="pro" stageId="source" deadline={deadline} onDone={done} onClose={close} />)); }
async function input(selector: string, value: string) { act(() => { const element = document.querySelector<HTMLInputElement>(selector)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function confirm() { act(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); }
async function submit() { await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; document.body.innerHTML = '<div id="root"></div>'; root = createRoot(document.getElementById("root")!); vi.clearAllMocks(); });
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });
it("requires explicit confirmation and date, then sends expected source and optional IST time", async () => {
  m.api.mockResolvedValue({ ok: true }); await mount();
  await submit(); expect(m.api).not.toHaveBeenCalled();
  await input('input[type="date"]', "2026-11-01"); await input('input[type="time"]', "05:30");
  expect(document.querySelector<HTMLButtonElement>('button[form]')!.disabled).toBe(true);
  await confirm(); await submit();
  expect(m.api).toHaveBeenCalledWith("POST", "/api/projects/deal/convert-to-bid", { expectedPipelineId: "pro", expectedStageId: "source", confirmed: true, submissionDeadline: "2026-11-01T05:30:00+05:30" });
  expect(done).toHaveBeenCalledOnce();
});
it("preserves existing exact deadline when only confirming conversion", async () => {
  m.api.mockResolvedValue({ ok: true }); await mount("2026-11-01T07:15:59.123Z"); await confirm(); await submit();
  expect(m.api.mock.calls[0][2].submissionDeadline).toBe("2026-11-01T07:15:59.123Z");
});
it("keeps input/confirmation on conflict and does not claim success", async () => {
  m.api.mockResolvedValue({ ok: false, error: "The pipeline changed. Refresh." }); await mount("2026-11-01"); await confirm(); await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Refresh");
  expect(document.querySelector<HTMLInputElement>('input[type="date"]')!.value).toBe("2026-11-01");
  expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true); expect(done).not.toHaveBeenCalled();
});
it("Cancel sends no conversion request", async () => {
  await mount("2026-11-01"); act(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click());
  expect(close).toHaveBeenCalledOnce(); expect(m.api).not.toHaveBeenCalled();
});
it("offers conversion only to managers of open writable Proactive deals", async () => {
  const deal: DealBlock = { pipeline: { id: "pro", key: "DEAL_PROACTIVE", name: "Proactive", stages: [] }, stage: { id: "source", name: "Conversation", category: "ACTIVE" }, stageReason: null, details: null, parties: [], organisation: null, nextStep: null, needsNextStep: false, stalled: false };
  const show = async (value: DealBlock, canManage: boolean, canWrite: boolean) => { await act(async () => root.render(<DealPanel projectId="deal" deal={value} canManage={canManage} canWrite={canWrite} onChange={() => {}} feed={{ status: "ready", tasks: [], openCount: 0 }} />)); return [...document.querySelectorAll("button")].some((b) => b.textContent === "Convert to Bid"); };
  expect(await show(deal, true, true)).toBe(true);
  expect(await show(deal, false, true)).toBe(false); expect(await show(deal, false, false)).toBe(false); expect(await show(deal, true, false)).toBe(false);
  for (const category of ["DONE", "LOST", "DELIVERY"]) expect(await show({ ...deal, stage: { ...deal.stage!, category } }, true, true)).toBe(false);
  expect(await show({ ...deal, pipeline: { ...deal.pipeline!, key: "DEAL_BID" } }, true, true)).toBe(false);
  expect(await show({ ...deal, stage: { ...deal.stage!, isRetired: true } }, true, true)).toBe(false);
});
