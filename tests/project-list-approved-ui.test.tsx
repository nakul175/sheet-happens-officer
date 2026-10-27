// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), query: "" }));
vi.mock("next/navigation", () => ({ usePathname: () => "/projects/fixture", useSearchParams: () => new URLSearchParams(nav.query), useRouter: () => nav }));
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ children, actions, beforeTitle, title, className }: { children: React.ReactNode; actions: React.ReactNode; beforeTitle: React.ReactNode; title: React.ReactNode; className: string }) => h("main", { className }, beforeTitle, h("h1", null, title), actions, children), useMe: () => ({ id: "me", orgRole: "MEMBER" }) }));
import ProjectView from "../src/app/(app)/projects/[id]/ProjectView";
let root: Root | undefined;
async function mount(role = "EDITOR", archived = false, query = "", many = false, identities = false) {
  nav.query = query; nav.push.mockReset(); nav.replace.mockReset();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  document.body.innerHTML = '<div id="root"></div>';
  const task = { updatedAt: "2026-10-27T00:00:00.000Z", sectionId: "todo", priority: "MEDIUM", dueDate: "2026-10-30", blocked: false, completedAt: null, assignee: { id: "me", name: "Me" }, collaborators: [], awaitingApproval: false, canClose: true, subtasks: { total: 0, open: 0 } };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const path = String(input);
    const sections: {id:string;name:string;isDone:boolean;total:number;nextCursor:null;tasks:(Omit<typeof task,"completedAt"> & {id:string;title:string;completedAt:string|null})[]}[] = [{ id: "todo", name: "To do", isDone: false, total: 1, nextCursor: null, tasks: [{ ...task, id: "open", title: "Open task with full name" }] }, { id: "done", name: "Done", isDone: true, total: 1, nextCursor: null, tasks: [{ ...task, id: "closed", sectionId: "done", title: "Completed task", completedAt: "2026-10-26T00:00:00Z" }] }];
    if (many) sections[0].tasks.push({ ...task, id: "extra", title: "Another task", priority: "HIGH" });
    if (many) sections[0].total = 2;
    if (identities && path.includes('/assignment-people')) return new Response(JSON.stringify({ people: [{ id: 'pending', name: 'Alex Morgan', email: 'pending@example.test', isMember: false }] }), { headers: { 'content-type': 'application/json' } });
    const data = path.includes("/tasks") ? { sections: path.includes("priority=HIGH") ? sections.map(s => ({...s,tasks:s.tasks.filter(t => t.priority === "HIGH")})) : sections } : path.includes("/views") ? { views: [], max: 10 } : { project: { id: "fixture", name: "Full Project Name", archived, role, sections, members: identities ? [{ userId: "me", name: "Alex Morgan", ...(role === "LEADER" ? { email: "alex.a@example.test" } : {}), role, active: true }, { userId: "leader", name: "Alex Morgan", ...(role === "LEADER" ? { email: "alex.b@example.test" } : {}), role: "LEADER", active: true }] : [{ userId: "me", name: "Me", role, active: true }, { userId: "leader", name: "Leader", role: "LEADER", active: true }] } };
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

it("approved Add task retains required title/due and the original task payload", async () => { const fetcher = await mount(); await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === "+ Add task")!.click()); const modal = document.querySelector('[role="dialog"]')!; const add = [...modal.querySelectorAll('button')].find(b => b.textContent === "Add task")!; expect(add.disabled).toBe(true); expect(modal.querySelector('[aria-label="Search workspace assignees"]')).toBeNull(); const title = modal.querySelector<HTMLInputElement>('input[maxlength="500"]')!, due = modal.querySelector<HTMLInputElement>('input[type="date"]')!; await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(title, "Fixture task"); title.dispatchEvent(new Event("input", { bubbles: true })); set.call(due, "2026-10-30"); due.dispatchEvent(new Event("input", { bubbles: true })); }); expect(add.disabled).toBe(false); await act(async () => modal.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); const call = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!; expect(call[0]).toBe("/api/projects/fixture/tasks"); expect(JSON.parse(String(call[1]!.body))).toMatchObject({ title: "Fixture task", sectionId: "todo", assigneeId: "me", dueDate: "2026-10-30", priority: "MEDIUM", collaboratorIds: [], addAssigneeToProject: false, addCollaboratorsToProject: [] }); });
it("only a live Leader gets explicit workspace-person lookup in Add task", async () => { await mount("LEADER"); await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === "+ Add task")!.click()); expect(document.querySelector('[role="dialog"] [aria-label="Search workspace assignees"]')).not.toBeNull(); expect(document.querySelector('[role="dialog"] [aria-label="Search workspace collaborators"]')).not.toBeNull(); expect(document.querySelector<HTMLSelectElement>('[role="dialog"] select[multiple]')!.multiple).toBe(true); });

it("section selection reports none, mixed and all without completing tasks", async () => {
 const fetcher = await mount("EDITOR", false, "", true);
 const all = document.querySelector<HTMLInputElement>('input[aria-label="Select all in To do"]')!;
 expect(all.checked).toBe(false); expect(all.indeterminate).toBe(false);
 await act(async()=>document.querySelector<HTMLInputElement>(`input[aria-label='Select "Open task with full name"']`)!.click());
 expect(all.indeterminate).toBe(true); expect(all.getAttribute("aria-checked")).toBe("mixed");
 await act(async()=>all.click()); expect(all.checked).toBe(true); expect(all.indeterminate).toBe(false);
 await act(async()=>all.click()); expect(all.checked).toBe(false);
 expect(fetcher.mock.calls.some(([,init])=>init?.method && init.method!=="GET")).toBe(false);
});
it("section select-all remains scoped to filtered displayed tasks", async () => {
 const fetcher = await mount("EDITOR", false, "priority=HIGH", true);
 expect(document.querySelector(`input[aria-label='Select "Open task with full name"']`)).toBeNull();
 const all = document.querySelector<HTMLInputElement>('input[aria-label="Select all in To do"]')!;
 await act(async()=>all.click());
 expect(document.querySelector<HTMLInputElement>(`input[aria-label='Select "Another task"']`)!.checked).toBe(true);
 expect(fetcher.mock.calls.some(([,init])=>init?.method && init.method!=="GET")).toBe(false);
});
it("read-only completion descriptions distinguish archived and Viewer restrictions", async () => {
 await mount("LEADER", true);expect(document.querySelector('.tick[disabled]')!.getAttribute('aria-label')).toContain('archived and read-only');
 act(()=>root?.unmount());root=undefined;
 await mount("VIEWER", false);expect(document.querySelector('.tick[disabled]')!.getAttribute('aria-label')).toContain('Viewers can read tasks but cannot change them');
});

it.each(["LEADER", "EDITOR"])("Add task displays only supplied authorized identities (%s)", async role => {
  await mount(role, false, "new=1", false, true);
  const dialog = document.querySelector('[role="dialog"]')!;
  const select = [...dialog.querySelectorAll('label')].find(el => el.textContent === 'Assignee')?.parentElement?.querySelector('select') ?? [...dialog.querySelectorAll('select')][1];
  expect([...select.options].map(o => o.value)).toEqual(['me', 'leader']);
  expect(select.textContent).toContain('Alex Morgan');
  if (role === 'LEADER') {
    expect(select.options[0].text).toBe('Alex Morgan — alex.a@example.test');
    expect(select.options[1].text).toBe('Alex Morgan — alex.b@example.test');
  } else expect(dialog.textContent).not.toContain('@example.test');
});
it("Add task retains available pending identity and defers the ID-based grant until save", async () => {
  const fetcher = await mount('LEADER', false, 'new=1', false, true);
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Search by name"]') ?? [...document.querySelectorAll<HTMLInputElement>('input')].find(el => el.closest('.new-task-form') && el.parentElement?.textContent?.includes('Search workspace assignees'))!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Alex'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Choose assignee')!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Add to project and assign')!.click());
  const option = document.querySelector<HTMLOptionElement>('option[value="pending"]')!;
  expect(option.textContent).toBe('Alex Morgan — pending@example.test (will join project)');
  expect(option.selected).toBe(true);
  expect(fetcher.mock.calls.every(([,init]) => !init?.method || init.method === 'GET')).toBe(true);
});
