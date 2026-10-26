// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { DeleteProject } from "../src/app/(app)/projects/[id]/members/Members";
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); });
it("names the project and retained work; cancellation sends no delete request", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const fetcher = vi.spyOn(globalThis, "fetch");
  const close = vi.fn();
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(DeleteProject, { id: "owned", name: "Annual plan", onClose: close })); });
  expect(document.body.textContent).toContain("Delete “Annual plan”?");
  expect(document.body.textContent).toContain("All tasks, subtasks, notes, links, memberships and history are retained.");
  expect([...document.querySelectorAll("button")].find(b => b.textContent === "Move to Trash")!.disabled).toBe(true);
  const cancel = [...document.querySelectorAll("button")].find(b => /cancel/i.test(b.textContent ?? ""))!;
  await act(async () => cancel.click());
  expect(close).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
});
