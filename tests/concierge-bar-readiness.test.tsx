// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Panel } from "@/components/concierge/Concierge";
const state = vi.hoisted(() => ({ loaded: false, messages: [] as { id: string; text: string }[] }));
vi.mock("next/navigation", () => ({ usePathname: () => "/projects/local-proof" }));
vi.mock("@/components/concierge/ConciergeProvider", () => ({ useConcierge: () => ({ ...state, available: true, loadError: null, busy: false, error: null, quickActions: [] }) }));
vi.mock("@/components/concierge/Composer", () => ({ Composer: ({ off }: { off: boolean }) => <textarea aria-label="Message the concierge" disabled={off} /> }));
vi.mock("@/components/concierge/MessageView", () => ({ MessageView: ({ m }: { m: { text: string } }) => <li>{m.text}</li> }));
vi.mock("@/components/ui", () => ({ Confirm: () => null }));
let root: Root;
const toggle = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Open chat" || b.textContent === "Collapse")!;
async function render() { await act(async () => root.render(<Panel variant="bar" />)); }
async function persistedThreadArrives() { state.loaded = true; state.messages = [{ id: "persisted", text: "Due this week in owned project" }]; await render(); }
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; state.loaded = false; state.messages = []; document.body.innerHTML = '<div id="root"></div>'; root = createRoot(document.getElementById("root")!); });
afterEach(() => act(() => root.unmount()));
it("a blind startup Open chat click can collapse the thread after asynchronous restoration", async () => {
  await render(); const oldOpener = toggle(); expect(oldOpener.textContent).toBe("Open chat");
  expect(document.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(true);
  await persistedThreadArrives(); expect(oldOpener.getAttribute("aria-expanded")).toBe("true");
  act(() => oldOpener.click()); expect(document.querySelector('[aria-label="Conversation"]')).toBeNull();
});
it("waiting for the enabled composer and checking expansion preserves the restored thread", async () => {
  await render(); await persistedThreadArrives();
  expect(document.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(false);
  if (toggle().getAttribute("aria-expanded") === "false") act(() => toggle().click());
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('[aria-label="Conversation"]')?.textContent).toContain("Due this week in owned project");
});
