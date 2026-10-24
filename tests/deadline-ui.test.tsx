// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DealPanel, type DealBlock } from "../src/components/DealPanel";

const deal: DealBlock = {
  pipeline: { id: "pipe", key: "DEAL_BID", name: "Bid", stages: [] }, stage: null, stageReason: null,
  details: { whyPursue: "Test need", need: null, serviceLine: null, value: null, currency: null, probability: null, expectedClose: null, introducedBy: null, submissionDeadline: "2026-10-25T07:15:59.123Z", submissionDeadlineHasTime: true },
  parties: [], organisation: { id: "old", name: "Old Buyer" }, nextStep: null, needsNextStep: false, stalled: false,
};
let root: Root;
let requests: { path: string; body: unknown }[];
let fail: boolean;
const changed = vi.fn();
const buttons = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].filter(b => b.textContent === name);
async function click(name: string) { await act(async () => { buttons(name)[0].click(); }); }
async function mount(canManage: boolean, canWrite = true) {
  await act(async () => {
    root = createRoot(document.getElementById("root")!);
    root.render(h(DealPanel, { projectId: "deal-3051", projectName: "Old name", deal, canWrite, canManage, onChange: changed, feed: { status: "ready", openCount: 0, tasks: [] } }));
  });
}
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  requests = []; fail = false; changed.mockReset();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      requests.push({ path: String(input), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(fail ? { error: "This project is read-only." } : { status: "ok" }), { status: fail ? 403 : 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ notes: [] }), { headers: { "content-type": "application/json" } });
  });
});
afterEach(() => { act(() => root?.unmount()); vi.restoreAllMocks(); });


it("unrelated detail edit preserves seconds/milliseconds while showing IST controls",async()=>{
  await mount(true);await click("Edit details");
  expect(document.querySelector<HTMLInputElement>('input[type="date"][value="2026-10-25"]')).not.toBeNull();
  expect(document.querySelector<HTMLInputElement>('input[type="time"]')?.value).toBe("12:45");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("IST (UTC+05:30)");
  const why=document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(why,"Updated why");why.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>{document.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
  expect(requests[0].body).toMatchObject({whyPursue:"Updated why",submissionDeadline:"2026-10-25T07:15:59.123Z"});
});
it("explicit time change uses chosen IST minute and clearing date clears optional time",async()=>{
  await mount(true);await click("Edit details");
  const time=document.querySelector<HTMLInputElement>('input[type="time"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(time,"05:30");time.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>{document.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
  expect(requests[0].body).toMatchObject({submissionDeadline:"2026-10-25T05:30:00+05:30"});
});
