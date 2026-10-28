// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), query: "" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push, replace: m.replace }), useSearchParams: () => new URLSearchParams(m.query) }));
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ title, children, actions, beforeTitle }: { title: string; children: React.ReactNode; actions: React.ReactNode; beforeTitle: React.ReactNode }) => h("main", null, beforeTitle, h("h1", null, title), actions, children), useMe: () => ({ id: "leader" }) }));
vi.mock("@/components/TaskModal", () => ({ TaskModal: ({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) => h("div", { role: "dialog", "aria-label": "Task" }, id, h("button", { onClick: onClose }, "Close"), h("button", { onClick: onChanged }, "Changed")) }));
import Workload from "../src/app/(app)/workload/Workload";
let root: Root | undefined;
async function mount(query = "", status = 200, duplicateNames = false) {
  m.query = query;
  document.body.innerHTML = '<div id="root"></div>';
  const summary = { dueWindow: { from: "2026-10-28", through: "2026-11-03" }, items: [{ id: "person", name: "Alice", email: "alice.one@example.test", open: 3, due: 1, overdue: 1, approval: 0, blocked: 1 }] };
  if (duplicateNames) summary.items.push({ ...summary.items[0], id: "person-2", email: "alice.two@example.test" });
  const tasks = { person: { id: "person", name: "Alice" }, metric: "overdue", total: 27, items: [{ id: "task-1", title: "A full readable task title", parentId: null, dueDate: "2026-10-01", priority: "HIGH", blocked: true, project: { id: "project", name: "Allowed project" } }], nextCursor: "last-task" };
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async input => new Response(JSON.stringify(status !== 200 ? { error: "Workload not found" } : String(input).includes("?") ? tasks : summary), { status, headers: { "content-type": "application/json" } }));
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(Workload)); });
  return fetcher;
}
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); vi.clearAllMocks(); });
it("links all five counts to their matching person/metric URL and identifies the selected count", async () => {
  await mount("assignee=person&f=overdue");
  const links = [...document.querySelectorAll<HTMLAnchorElement>(".workload-count")];
  expect(links).toHaveLength(5);
  expect(links.map(a => a.getAttribute("href"))).toEqual(["/workload?assignee=person#workload-tasks", "/workload?assignee=person&due=next7#workload-tasks", "/workload?assignee=person&f=overdue#workload-tasks", "/workload?assignee=person&f=awaiting#workload-tasks", "/workload?assignee=person&f=blocked#workload-tasks"]);
  expect(document.querySelector('.workload-count[aria-current="page"]')!.getAttribute("aria-label")).toBe("Alice: 1 overdue");
  expect(document.querySelector('.workload-metrics [aria-current="page"]')!.textContent).toBe("Overdue 1");
  expect(document.body.textContent).toContain("2026-10-28 – 2026-11-03");
});
it("opens the existing task editor and retains filters when closing it", async () => {
  await mount("assignee=person&f=blocked&task=task-1");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("task-1");
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Close")!.click());
  expect(m.replace).toHaveBeenCalledWith("/workload?assignee=person&f=blocked", { scroll: false });
  await act(async () => document.querySelector<HTMLButtonElement>(".workload-task-title")!.click());
  expect(m.push).toHaveBeenCalledWith("/workload?assignee=person&f=blocked&task=task-1", { scroll: false });
});
it("pages without dropping the filters and refreshes counts/list after existing task changes and Undo", async () => {
  const fetcher = await mount("assignee=person&f=overdue&task=task-1");
  expect(document.querySelector<HTMLAnchorElement>('.workload-pagination a')!.getAttribute("href")).toBe("/workload?assignee=person&f=overdue&cursor=last-task#workload-tasks");
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Changed")!.click());
  expect(fetcher).toHaveBeenCalledTimes(4);
  await act(async () => { expect(window.dispatchEvent(new Event("sho:undone", { cancelable: true }))).toBe(false); });
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});
it("removes counts and the editor when access is revoked", async () => {
  await mount("assignee=person&task=task-1", 404);
  expect(document.body.textContent).toContain("Workload isn't available for your account.");
  expect(document.querySelector(".workload-table")).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("refuses ambiguous filters without requesting an arbitrary task list", async () => {
  const fetcher = await mount("assignee=person&due=next7&f=overdue&task=task-1");
  expect(document.querySelector('[role="alert"]')!.textContent).toContain("filter isn't valid");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("distinguishes same-name people with their already-authorized email", async () => {
  await mount("", 200, true);
  expect([...document.querySelectorAll(".workload-person-email")].map(el => el.textContent)).toEqual(["alice.one@example.test", "alice.two@example.test"]);
  expect(document.querySelector('[aria-label="Alice (alice.one@example.test): 3 open tasks"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Alice (alice.two@example.test): 3 open tasks"]')).not.toBeNull();
});
