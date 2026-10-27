// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HolySheetLauncher } from "../src/components/HolySheetLauncher";

let host: HTMLDivElement, root: Root;
const fetcher = vi.fn();
const origin = "https://staging.holysheet.aplyd.org";
const page = "12345678-1234-1234-1234-123456789abc";
const context = (subject = "qa-owner") => Response.json({origin, subject});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset(); fetcher.mockImplementation(async () => context());
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(createElement(HolySheetLauncher, {taskId: "qa-task"}))); }
async function open() {
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, `${origin}/pages/${page}`);
    input.dispatchEvent(new Event("input", {bubbles: true}));
  });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
}
async function focus() { await act(async () => window.dispatchEvent(new Event("focus"))); }
it("does not mount a frame before verification or when integration is unavailable", async () => {
  fetcher.mockResolvedValue(new Response("{}", {status: 404})); await render();
  expect(host.querySelector("iframe")).toBeNull(); expect(host.textContent).toBe("");
});
it("opens only the verified subject and keeps the standalone link bound to the opened document", async () => {
  await render(); await open();
  expect(host.querySelector("iframe")?.getAttribute("src")).toBe(`${origin}/embed/pages/${page}#hs-user=qa-owner`);
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://evil.test");
    input.dispatchEvent(new Event("input", {bubbles: true}));
  });
  expect(host.querySelector("a")?.href).toBe(`${origin}/pages/${page}`);
  expect(host.querySelector("iframe")?.getAttribute("sandbox")).not.toContain("allow-top-navigation");
});
it("preserves an open frame on an unchanged account check, then removes it on account change", async () => {
  await render(); await open(); const frame = host.querySelector("iframe"); await focus();
  expect(host.querySelector("iframe")).toBe(frame);
  fetcher.mockImplementation(async () => context("qa-viewer")); await focus();
  expect(host.querySelector("iframe")).toBeNull();
});
it.each([401, 404, 503])("removes an open frame on a %s task/session response", async status => {
  await render(); await open(); expect(host.querySelector("iframe")).not.toBeNull();
  fetcher.mockImplementation(async () => new Response("{}", {status})); await focus();
  expect(host.querySelector("iframe")).toBeNull();
});
it("ignores an older successful check after a newer denial", async () => {
  await render(); await open(); let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}));
  await focus(); fetcher.mockResolvedValueOnce(new Response("{}", {status: 401})); await focus();
  await act(async () => finish(context()));
  expect(host.querySelector("iframe")).toBeNull();
  expect(host.textContent).toContain("Sign in to your task again.");
});
it.each([
  {origin:"https://evil.test",subject:"qa-owner"},
  {origin,subject:""},
  {origin,subject:"x".repeat(201)},
])("does not mount content for invalid provider context",async result=>{
  await render();fetcher.mockResolvedValue(Response.json(result));await open();
  expect(host.querySelector("iframe")).toBeNull();expect(host.textContent).toContain("Document access could not be checked");
});
