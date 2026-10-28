// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachTaskSheetBack, openTaskSheet } from "@/lib/task-sheet-history";

let detach = () => {};
beforeEach(() => history.replaceState({ opaque: "router-state" }, "", "/projects/one"));
afterEach(() => { detach(); vi.restoreAllMocks(); });
function attach(blocked = false, nestedClose: () => (() => void) | null = () => null) {
  const beforePrompt = vi.fn(), prompt = vi.fn();
  const control = attachTaskSheetBack({ id: "task-one", blocked: () => blocked, beforePrompt, prompt, nestedClose });
  detach = control.detach;
  return { ...control, beforePrompt, prompt };
}
function pop(state: unknown, href: string) {
  history.replaceState(state, "", href);
  const event = new PopStateEvent("popstate", { state });
  const stopped = vi.spyOn(event, "stopImmediatePropagation");
  window.dispatchEvent(event);
  return stopped;
}
it("only handles an opening on the current page and preserves the background's opaque router state", () => {
  expect(openTaskSheet("/elsewhere?task=task-one")).toBe(false);
  expect(openTaskSheet("https://elsewhere.test/projects/one?task=task-one")).toBe(false);
  expect(openTaskSheet("/projects/one?task=task-one")).toBe(true);
  expect(location.search).toBe("?task=task-one");
  expect(history.state.__shoTaskSheet.base).toBe(`${location.origin}/projects/one`);
  expect(openTaskSheet("/projects/one?task=another")).toBe(false);
});
it("has the task URL and marked entry in place before a synchronous router observer mounts the sheet", () => {
  let mounted: ReturnType<typeof attachTaskSheetBack> | undefined;
  const observe = () => { mounted = attachTaskSheetBack({ id: "task-one", blocked: () => true, beforePrompt: vi.fn(), prompt: vi.fn(), nestedClose: () => null }); };
  // Next updates its observers before calling the original History method. A sheet can mount there.
  vi.spyOn(history, "pushState").mockImplementation((data, unused, url) => { observe(); History.prototype.pushState.call(history, data, unused, url); });
  vi.spyOn(history, "replaceState").mockImplementation((data, unused, url) => { observe(); History.prototype.replaceState.call(history, data, unused, url); });
  const back = vi.spyOn(history, "back").mockImplementation(() => {});
  openTaskSheet("?task=task-one");
  detach = () => mounted?.detach();
  expect(mounted?.close()).toBe(true);
  expect(back).toHaveBeenCalledOnce();
});
it("normalizes a direct link once and reuses that entry after remount/reload", () => {
  history.replaceState({ opaque: "router-state" }, "", "/projects/one?task=task-one");
  const before = history.length;
  attach();
  expect(history.length).toBe(before + 1);
  expect(history.state.opaque).toBe("router-state");
  const token = history.state.__shoTaskSheet.token;
  detach(); attach();
  expect(history.length).toBe(before + 1);
  expect(history.state.__shoTaskSheet.token).toBe(token);
});
it("does not duplicate a Workload entry when the invoking list had a fragment", () => {
  history.replaceState({}, "", "/workload#workload-tasks");
  openTaskSheet("/workload?task=task-one");
  const before = history.length;
  attach();
  expect(history.length).toBe(before);
});
it("allows a clean Back to reach the router without restoration", () => {
  openTaskSheet("?task=task-one");
  const e = history.state.__shoTaskSheet;
  const { prompt } = attach();
  const forward = vi.spyOn(history, "forward").mockImplementation(() => {});
  expect(pop({ __shoTaskBase: e.token }, e.base)).not.toHaveBeenCalled();
  expect(forward).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled();
});
it("restores the same task before prompting, pauses blur saves first, and does not store draft text", () => {
  openTaskSheet("?task=task-one");
  const state = history.state, e = state.__shoTaskSheet;
  const { beforePrompt, prompt } = attach(true);
  const forward = vi.spyOn(history, "forward").mockImplementation(() => {});
  expect(pop({ __shoTaskBase: e.token }, e.base)).toHaveBeenCalledOnce();
  expect(beforePrompt).toHaveBeenCalledOnce(); expect(forward).toHaveBeenCalledOnce();
  expect(prompt).not.toHaveBeenCalled();
  expect(pop(state, e.href)).toHaveBeenCalledOnce();
  expect(prompt).toHaveBeenCalledOnce();
  expect(Object.keys(state.__shoTaskSheet).sort()).toEqual(["base", "href", "id", "token", "v"]);
});
it("captures exactly the nested dialog being dismissed and leaves the task draft prompt alone", () => {
  openTaskSheet("?task=task-one");
  const state = history.state, e = state.__shoTaskSheet, nested = vi.fn();
  const { prompt, beforePrompt } = attach(true, () => nested);
  vi.spyOn(history, "forward").mockImplementation(() => {});
  pop({ __shoTaskBase: e.token }, e.base);
  expect(nested).not.toHaveBeenCalled();
  pop(state, e.href);
  expect(nested).toHaveBeenCalledOnce();
  expect(prompt).not.toHaveBeenCalled(); expect(beforePrompt).not.toHaveBeenCalled();
});
it("Close consumes the marked task entry once, allowing the router's resulting Back", () => {
  openTaskSheet("?task=task-one");
  const e = history.state.__shoTaskSheet;
  const { close, prompt } = attach(true);
  const back = vi.spyOn(history, "back").mockImplementation(() => {});
  expect(close()).toBe(true); expect(back).toHaveBeenCalledOnce();
  expect(pop({ __shoTaskBase: e.token }, e.base)).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled(); expect(close()).toBe(false);
});
it("detaches traversal and unload protection when the sheet unmounts", () => {
  openTaskSheet("?task=task-one");
  const state = history.state, e = state.__shoTaskSheet;
  attach(true);
  const blocked = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(blocked);
  expect(blocked.defaultPrevented).toBe(true);
  detach();
  const clean = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
  expect(pop({ __shoTaskBase: e.token }, e.base)).not.toHaveBeenCalled();
});
