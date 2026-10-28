// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachOverlayBack, closeTopOverlayThen } from "@/lib/overlay-history";
let detach: (() => void)[] = [];
beforeEach(() => history.replaceState({ opaque: "router" }, "", "/projects/one?view=board"));
afterEach(() => { detach.forEach(fn => fn()); detach = []; vi.restoreAllMocks(); });
function attach(id = "panel", nested: () => (() => void) | null = () => null) {
  const onClose = vi.fn(), control = attachOverlayBack(id, onClose, nested);
  detach.push(control.detach); return { ...control, onClose, entry: history.state.__shoPanel, state: history.state };
}
function pop(state: unknown) {
  History.prototype.replaceState.call(history, state, "");
  window.dispatchEvent(new PopStateEvent("popstate", { state }));
}
it("adds one same-URL entry and retains opaque router data", () => {
  const before = history.length, href = location.href;
  attach();
  expect(history.length).toBe(before + 1); expect(location.href).toBe(href);
  expect(history.state.opaque).toBe("router");
});
it("reuses its marked entry when effects remount", () => {
  const first = attach(), before = history.length;
  first.detach(); const second = attach();
  expect(second.entry.token).toBe(first.entry.token); expect(history.length).toBe(before);
});
it("Back closes exactly the open overlay", () => {
  const { entry, onClose } = attach();
  pop({ __shoPanelBase: entry.token, opaque: "router" });
  expect(onClose).toHaveBeenCalledOnce();
});
it("double Close traverses once and runs a selection only after closing", () => {
  const { close, onClose, entry } = attach(), after = vi.fn();
  const back = vi.spyOn(history, "back").mockImplementation(() => {});
  close(after); close(after);
  expect(back).toHaveBeenCalledOnce(); expect(onClose).not.toHaveBeenCalled(); expect(after).not.toHaveBeenCalled();
  pop({ __shoPanelBase: entry.token });
  expect(onClose).toHaveBeenCalledOnce(); expect(after).toHaveBeenCalledOnce();
  expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(after.mock.invocationCallOrder[0]);
});
it("nested overlays consume separate Back entries", () => {
  const outer = attach("drawer"), inner = attach("move");
  pop({ ...outer.state, __shoPanelBase: inner.entry.token });
  expect(inner.onClose).toHaveBeenCalledOnce(); expect(outer.onClose).not.toHaveBeenCalled();
  inner.detach(); pop({ __shoPanelBase: outer.entry.token });
  expect(outer.onClose).toHaveBeenCalledOnce();
});
it("restores before closing a nested confirmation and leaves the root overlay open", () => {
  const nested = vi.fn(), control = attach("move", () => nested);
  const forward = vi.spyOn(history, "forward").mockImplementation(() => {});
  pop({ __shoPanelBase: control.entry.token });
  expect(forward).toHaveBeenCalledOnce(); expect(nested).not.toHaveBeenCalled();
  pop(control.state);
  expect(nested).toHaveBeenCalledOnce(); expect(control.onClose).not.toHaveBeenCalled();
});
it("ignores an unrelated navigation after detach", () => {
  const control = attach(); control.detach();
  pop({ __shoPanelBase: control.entry.token });
  expect(control.onClose).not.toHaveBeenCalled();
});

it("queues a new overlay after an outside-click Close already requested Back", () => {
  const { close, onClose, entry } = attach("more"), revealAccount = vi.fn();
  const back = vi.spyOn(history, "back").mockImplementation(() => {});
  close(); closeTopOverlayThen(revealAccount);
  expect(back).toHaveBeenCalledOnce(); expect(revealAccount).not.toHaveBeenCalled();
  pop({ __shoPanelBase: entry.token });
  expect(onClose).toHaveBeenCalledOnce(); expect(revealAccount).toHaveBeenCalledOnce();
  expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(revealAccount.mock.invocationCallOrder[0]);
});
it("finished or detached overlays do not delay a new opener", () => {
  const control = attach("account"); control.detach();
  const reveal = vi.fn(); closeTopOverlayThen(reveal);
  expect(reveal).toHaveBeenCalledOnce();
});
