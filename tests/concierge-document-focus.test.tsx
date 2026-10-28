// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConciergeProvider } from "../src/components/concierge/ConciergeProvider";
const mock = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock("../src/components/concierge/api", () => ({ conciergeApi: { state: mock.state } }));
let root: Root;
let resolveState: (result: unknown) => void;
let focus: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
 document.body.innerHTML = '<div id="app"></div>';
 document.body.removeAttribute("tabindex");
 mock.state.mockImplementation(() => new Promise(resolve => { resolveState = resolve; }));
 focus = vi.spyOn(document.body, "focus");
 root = createRoot(document.getElementById("app")!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.removeAttribute("tabindex"); });
async function render() { await act(async () => root.render(<ConciergeProvider><a href="#main">Skip to content</a><input aria-label="Own input" /></ConciergeProvider>)); }
async function finish() { await act(async () => resolveState({ ok: true, data: { available: true, hidden: false, voiceNoticeAcked: true, quickActions: [], messages: [] } })); }
it.each([null, "0", "-1"])("resets an untouched document while restoring its tabindex (%s)", async (before) => {
 await render(); if (before !== null) document.body.setAttribute("tabindex", before);
 await finish(); expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
 expect(document.body.getAttribute("tabindex")).toBe(before);
});
it("preserves a link the person focused before state arrives", async () => {
 await render(); const link = document.querySelector("a")!; link.focus(); await finish();
 expect(document.activeElement).toBe(link); expect(focus).not.toHaveBeenCalled();
});
it("preserves a pointer-selected document starting point even if activeElement remains body", async () => {
 await render(); document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
 expect(document.activeElement).toBe(document.body); await finish(); expect(focus).not.toHaveBeenCalled();
});
it("preserves prior keyboard intent even if activeElement remains body", async () => {
 await render(); document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
 await finish(); expect(focus).not.toHaveBeenCalled();
});
