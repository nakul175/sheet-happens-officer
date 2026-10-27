// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ children, beforeTitle }: { children: React.ReactNode; beforeTitle: React.ReactNode }) => h("main", null, beforeTitle, children), useMe: () => ({ id: "me", orgRole: "ADMIN" }) }));
import NewProject from "../src/app/(app)/projects/new/NewProject";
let root: Root | undefined;
let responseOk = true;
async function mount() {
  responseOk = true; push.mockReset();
  document.body.innerHTML = '<div id="root"></div>';
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const data = init?.method === "POST" ? responseOk ? { project: { id: "created" } } : { error: "Try again" } : String(input) === "/api/team" ? { people: [{ id: "me", name: "Me", status: "ACTIVE" }, { id: "unverified", name: "Unverified", status: "UNVERIFIED" }, { id: "gone", name: "Deactivated", status: "DEACTIVATED" }, ...Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `Person ${i}`, status: "ACTIVE" }))] } : { verticals: [{ id: "active", name: "Active" }, { id: "retired", name: "Retired", retired: true }] };
    return new Response(JSON.stringify(data), { status: init?.method === "POST" && !responseOk ? 400 : 200, headers: { "content-type": "application/json" } });
  }); globalThis.fetch = fetcher;
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(NewProject)); });
  return fetcher;
}
async function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLInputElement ? "input" : "change", { bubbles: true })); });
}
function named(label: string) { const node = [...document.querySelectorAll("label")].find(n => n.textContent === label)!; return document.getElementById(node.htmlFor)! as HTMLInputElement | HTMLSelectElement; }
async function submit() { await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); });
it("keeps default Leader, required name, retired exclusion and a navigation-only Cancel", async () => {
  const fetcher = await mount();
  expect(named("Leader").textContent).toContain("Me (you)");
  expect((named("Project name *") as HTMLInputElement).maxLength).toBe(200);
  expect((named("Project name *") as HTMLInputElement).required).toBe(true);
  expect(named("Vertical (optional)").textContent).not.toContain("Retired");
  expect(document.querySelector('a[href="/projects"]')!.textContent).toBe("Projects");
  expect([...document.querySelectorAll('a[href="/projects"]')].some(a => a.textContent === "Cancel")).toBe(true);
  await submit();
  expect(fetcher.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(0);
});
it("keeps eligible member search and submits Viewer membership with first-task navigation", async () => {
  const fetcher = await mount();
  expect(document.querySelector('[aria-label="People"]')!.textContent).not.toMatch(/Unverified|Deactivated/);
  const find = document.querySelector<HTMLInputElement>('[aria-label="Find a person"]')!;
  await change(find, "Person 3");
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  await act(async () => { document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
  await change(document.querySelector<HTMLSelectElement>('[aria-label="Role of Person 3"]')!, "VIEWER");
  await change(named("Project name *"), "New delivery");
  await submit();
  const call = fetcher.mock.calls.find(([,i]) => i?.method === "POST")!;
  expect(JSON.parse(String(call[1]!.body))).toEqual({ name: "New delivery", description: null, leaderId: "me", members: [{ userId: "p3", role: "VIEWER" }] });
  expect(push).toHaveBeenCalledWith("/projects/created?new=1");
});
it("excludes the new Leader from members, explains creator Editor and retries API failure", async () => {
  const fetcher = await mount();
  await act(async () => { named("Leader").click(); });
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(option => option.textContent === "Person 0")!.click(); });
  expect(document.body.textContent).toContain("you are added as an Editor");
  expect([...document.querySelectorAll('.ppl-l')].some(n => n.textContent === "Person 0")).toBe(false);
  await change(named("Project name *"), "Failed then retried");
  responseOk = false; await submit();
  expect(document.querySelector('[role="alert"]')!.textContent).toBe("Try again");
  expect(push).not.toHaveBeenCalled();
  responseOk = true; await submit();
  expect(fetcher.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(2);
  expect(push).toHaveBeenCalledOnce();
});
