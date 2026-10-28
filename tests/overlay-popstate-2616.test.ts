// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { initializeOverlayPopstate, onOverlayPopstate } from "@/lib/overlay-popstate";
let detach: (() => void)[] = [];
afterEach(() => { detach.forEach(fn => fn()); detach = []; });
it("qa:TC missing SHO-2616: the persistent listener invokes the most recent sheet first and stops there", () => {
  initializeOverlayPopstate(); const outer = vi.fn(), inner = vi.fn((event: PopStateEvent) => event.stopImmediatePropagation());
  detach.push(onOverlayPopstate(outer), onOverlayPopstate(inner));
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(inner).toHaveBeenCalledOnce(); expect(outer).not.toHaveBeenCalled();
});
it("qa:TC missing SHO-2616: removing a sheet leaves normal browser/router listeners reachable", () => {
  const sheet = vi.fn(), router = vi.fn(); const stop = onOverlayPopstate(sheet); stop();
  window.addEventListener("popstate", router); detach.push(() => window.removeEventListener("popstate", router));
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(sheet).not.toHaveBeenCalled(); expect(router).toHaveBeenCalledOnce();
});
it("qa:TC missing SHO-2616: unsubscribe during a Back callback is safe", () => {
  const called: string[] = [], outer = onOverlayPopstate(() => called.push("outer"));
  detach.push(outer, onOverlayPopstate(event => { called.push("inner"); outer(); event.stopImmediatePropagation(); }));
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(called).toEqual(["inner"]);
});
