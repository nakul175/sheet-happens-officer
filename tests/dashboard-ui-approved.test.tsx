// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const nav = vi.hoisted(() => ({ push: vi.fn(), query: "", path: "/my-tasks" }));
vi.mock("next/navigation", () => ({ useRouter: () => nav, useSearchParams: () => new URLSearchParams(nav.query), usePathname: () => nav.path }));
vi.mock("@/components/extras/Extras", () => ({ useExtras: () => ({ canAdd: false, openAdd: vi.fn() }) }));
vi.mock("@/components/TaskModal", () => ({ TaskModal: ({ onClose }: { onClose: () => void }) => h("button", { onClick: onClose }, "Close fixture task") }));
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ title, children, actions }: { title: React.ReactNode; children: React.ReactNode; actions: React.ReactNode }) => h("main", null, h("h1", null, title), actions, children), useMe: () => ({ id: "me", crm: false, startGuide: false }) }));
import Dashboard from "../src/app/(app)/Dashboard";
import MyTasks from "../src/app/(app)/MyTasks";
let root: Root | undefined;
const item = { id: "task", title: "Full task name", dueDate: "2020-01-01", priority: "MEDIUM", canClose: true, project: { id: "project", name: "Full project name" }, parent: null, awaitingApproval: false, relation: "ASSIGNEE", updatedAt: "2026-10-27T00:00:00Z" };
async function mount(which: "home" | "tasks", partialError = false) {
  document.body.innerHTML = '<div id="root"></div>'; nav.push.mockReset();
  globalThis.fetch = vi.fn(async input => {
    const path = String(input);
    const data = path.includes("panel=tasks") ? { asOf: "2026-10-27T00:00:00Z", open: 300, overdue: 12, awaiting: 1, priorities: [item], approvals: [] } : path.includes("panel=projects") ? { asOf: "2026-10-27T00:00:00Z", total: 10, items: [{ id: "project", name: "Full project name", total: 8, completed: 3, percent: 38 }] } : path.includes("panel=activity") ? { items: [], asOf: "2026-10-27T00:00:00Z" } : { waitingOnMe: [], waitingOnOthers: [], overdue: [item], next7: [], later: [] };
    return new Response(JSON.stringify(data), { status: partialError && path.includes("panel=projects") ? 500 : 200, headers: { "content-type": "application/json" } });
  });
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(which === "home" ? Dashboard : MyTasks)); });
}
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); });
it("Home uses aggregate totals rather than visible rows and has real summary destinations", async () => {
  await mount("home");
  expect(document.querySelector('a[href="/my-tasks"]')!.textContent).toContain("300");
  expect(document.querySelector('a[href="/my-tasks?filter=overdue"]')!.textContent).toContain("12");
  expect(document.querySelector('a[href="/approvals"]')).not.toBeNull();
  expect(document.querySelector('a[href="/tasks/task"]')!.textContent).toContain("Full task name");
  expect(document.body.textContent).toContain("38%");
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
});
it("Home isolates panel failure and does not invent a zero count", async () => {
  await mount("home", true);
  expect(document.body.textContent).toContain("Full task name");
  expect(document.querySelector('a[href="/projects"]')!.textContent).toContain("—");
  expect(document.body.textContent).toContain("Retry");
});
it("My tasks preserves route/filter context when opening and closing an overlay", async () => {
  nav.query = "filter=overdue&task=task";
  await mount("tasks");
  await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === "Close fixture task")!.click());
  expect(nav.push).toHaveBeenCalledWith("/my-tasks?filter=overdue", { scroll: false });
  await act(async () => document.querySelector<HTMLElement>('.item.click')!.click());
  expect(nav.push).toHaveBeenCalledWith("/my-tasks?filter=overdue&task=task", { scroll: false });
});
