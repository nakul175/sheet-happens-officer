// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), query: "" }));
vi.mock("next/navigation", () => ({ usePathname: () => "/projects/fixture", useSearchParams: () => new URLSearchParams(nav.query), useRouter: () => nav }));
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ children, actions, beforeTitle, title, className }: { children: React.ReactNode; actions: React.ReactNode; beforeTitle: React.ReactNode; title: React.ReactNode; className: string }) => h("main", { className }, beforeTitle, h("h1", null, title), actions, children), useMe: () => ({ id: "me", orgRole: "MEMBER" }) }));
import ProjectView from "../src/app/(app)/projects/[id]/ProjectView";
let root: Root | undefined;
async function mount(role = "EDITOR", archived = false, query = "") {
  nav.query = query; nav.push.mockReset(); nav.replace.mockReset();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  document.body.innerHTML = '<div id="root"></div>';
  const task = { updatedAt: "2026-10-27T00:00:00.000Z", sectionId: "todo", priority: "MEDIUM", dueDate: "2026-10-30", blocked: false, completedAt: null, assignee: { id: "me", name: "Me" }, collaborators: [], awaitingApproval: false, canClose: true, subtasks: { total: 0, open: 0 } };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const sections = [{ id: "todo", name: "To do", isDone: false, total: 1, nextCursor: null, tasks: [{ ...task, id: "open", title: "Open task with full name" }] }, { id: "done", name: "Done", isDone: true, total: 1, nextCursor: null, tasks: [{ ...task, id: "closed", sectionId: "done", title: "Completed task", completedAt: "2026-10-26T00:00:00Z" }] }];
    const data = path.includes("/tasks") ? { sections } : path.includes("/views") ? { views: [], max: 10 } : { project: { id: "fixture", name: "Full Project Name", archived, role, sections, members: [{ userId: "me", name: "Me", role, active: true }, { userId: "leader", name: "Leader", role: "LEADER", active: true }] } };
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  }); globalThis.fetch = fetcher;
  const params = Promise.resolve({ id: "fixture" });
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(ProjectView, { params })); });
  return fetcher;
}
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); });
it("separates completion from bulk selection, and Editor sees no section menu", async () => {
  const fetcher = await mount();
  const selected = document.querySelector<HTMLInputElement>('input[aria-label=\'Select "Completed task"\']')!;
  expect(selected.checked).toBe(false);
  expect(document.querySelector('button[aria-label=\'Reopen "Completed task"\']')).not.toBeNull();
  await act(async () => selected.click());
  expect(selected.checked).toBe(true);
  expect(fetcher.mock.calls.every(([p]) => !String(p).includes("/reopen") && !String(p).includes("/complete"))).toBe(true);
  expect(document.querySelector('[aria-label^="Section menu"]')).toBeNull();
});
it("keeps Leader section actions and full heading separate from breadcrumb", async () => {
  await mount("LEADER");
  expect(document.querySelector('h1')!.textContent).toBe("Full Project Name");
  expect(document.querySelector('[aria-label="Breadcrumb"]')!.textContent).toContain("Projects");
  expect(document.querySelectorAll('[aria-label^="Section menu"]')).toHaveLength(2);
});
it("retains sort/group URL updates and task navigation", async () => {
  await mount();
  const sort = [...document.querySelectorAll("select")].find(el => el.parentElement!.textContent!.startsWith("Sort"))!;
  await act(async () => { sort.value = "priority"; sort.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(nav.replace.mock.calls[0][0]).toContain("sort=priority");
  await act(async () => { document.querySelector<HTMLElement>('.item.click')!.click(); });
  expect(nav.push.mock.calls[0][0]).toContain("task=open");
});
it("archived Viewer has no write or selection actions while keeping navigation", async () => {
  await mount("VIEWER", true);
  expect(document.body.textContent).toContain("archived and read-only");
  expect(document.querySelector('.sel')).toBeNull();
  expect([...document.querySelectorAll('button')].some(b => b.textContent === "+ Add task")).toBe(false);
  expect(document.querySelector('a[href="/projects/fixture/members"]')).not.toBeNull();
});

it("Board hides Group and bulk selectors, preserves visible Move to and isolates its click", async () => {
  await mount("EDITOR", false, "view=board");
  expect(document.querySelector(".project-board-view")).not.toBeNull();
  expect(document.querySelector(".sel")).toBeNull();
  expect(document.body.textContent).not.toContain("Group by");
  const move = document.querySelector<HTMLButtonElement>(".bmove")!;
  expect(move).not.toBeNull();
  await act(async () => move.click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(nav.push).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label^="Section menu"]')).toBeNull();
});
