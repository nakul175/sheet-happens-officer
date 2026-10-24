// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DealPanel, type DealBlock } from "../src/components/DealPanel";

const deal: DealBlock = {
  pipeline: { id: "pipe", key: "DEAL_BID", name: "Bid", stages: [] }, stage: null, stageReason: null,
  details: { whyPursue: "Test need", need: null, serviceLine: null, value: null, currency: null, probability: null, expectedClose: null, introducedBy: null, submissionDeadline: null },
  parties: [], organisation: null, nextStep: null, needsNextStep: false, stalled: false,
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

it("Leader/admin can rename using project PATCH, refreshes only after success, and exposes existing Change leader flow", async () => {
  await mount(true);
  expect(document.querySelector('a[href="/projects/deal-3051/members"]')?.textContent).toBe("Change leader");
  await click("Rename opportunity");
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  expect(input.value).toBe("Old name");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  New opportunity  ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(requests).toEqual([{ path: "/api/projects/deal-3051", body: { name: "New opportunity" } }]);
  expect(changed).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("Editor retains details editing but cannot rename or change leader", async () => {
  await mount(false);
  expect(buttons("Edit details")).toHaveLength(1);
  expect(buttons("Rename opportunity")).toHaveLength(0);
  expect(document.querySelector('a[href$="/members"]')).toBeNull();
});
it("Viewer has no editing controls", async () => {
  await mount(false, false);
  expect(buttons("Edit details")).toHaveLength(0);
  expect(buttons("Rename opportunity")).toHaveLength(0);
});
it("Cancel leaves original name unchanged without a request", async () => {
  await mount(true); await click("Rename opportunity"); await click("Cancel");
  expect(requests).toHaveLength(0); expect(changed).not.toHaveBeenCalled();
});
it("Server failure preserves input and dialog, and does not claim a refresh", async () => {
  fail = true; await mount(true); await click("Rename opportunity");
  await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("This project is read-only.");
  expect(document.querySelector<HTMLInputElement>('input')?.value).toBe("Old name");
  expect(changed).not.toHaveBeenCalled();
});
