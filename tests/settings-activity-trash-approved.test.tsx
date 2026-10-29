// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const undo = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/UndoHost", () => ({ requestUndo: undo }));
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ title, className, children, beforeTitle, actions }: { title: React.ReactNode; className: string; children: React.ReactNode; beforeTitle: React.ReactNode; actions: React.ReactNode }) => h("main", { className }, beforeTitle, h("h1", null, title), actions, children), useMe: () => ({ orgRole: "ADMIN" }) }));
import Members from "../src/app/(app)/projects/[id]/members/Members";
import Activity, { showUndo, showTooOld } from "../src/app/(app)/projects/[id]/activity/Activity";
import Trash from "../src/app/(app)/projects/[id]/trash/Trash";
let root: Root | undefined;
let calls: { path: string; init?: RequestInit }[] = [];
let postMode = "ok";
async function mount(which: "settings" | "activity" | "trash", role = "LEADER", archived = false) {
  calls = []; postMode = "ok"; undo.mockReset();
  document.body.innerHTML = '<div id="root"></div>';
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); calls.push({ path, init });
    let status = 200;
    let data: unknown = path.includes("/activity?") ? { items: [{ id: "page2", ts: Date.now(), when: "27 Oct 2026", who: "Actor", via: "", kind: "task.updated", what: "page two", undo: "none" }], nextCursor: null } : path.endsWith("/activity") ? { items: [{ id: "a", ts: Date.now(), when: "27 Oct 2026", who: "Full Actor Name", via: "concierge", kind: "task.updated", what: "changed a task", undo: "available" }], nextCursor: "next" } : path.endsWith("/trash") ? { items: [{ id: "child", title: "Full child title", isSubtask: true, parentTitle: "Full parent title", deletedAt: new Date().toISOString(), deletedBy: null, daysLeft: 1 }] } : path === "/api/team" ? { people: [{ id: "leader", name: "Leader", status: "ACTIVE" }, { id: "active", name: "Eligible Person", status: "ACTIVE" }, { id: "inactive", name: "Ineligible Person", status: "DEACTIVATED" }] } : path === "/api/verticals" ? { verticals: [{ id: "old", name: "Old vertical", retired: true }, { id: "retired", name: "Other retired", retired: true }] } : { project: { id: "fixture", name: "Full Project", role, archived, verticalId: "old", members: [{ userId: "leader", name: "Leader", role: "LEADER", active: true }, { userId: "editor", name: "Editor", role: "EDITOR", active: true }] } };
    if (init?.method === "POST" && postMode === "parent") { status = 409; data = { needsConfirm: "parent", parentTitle: "Full parent title" }; }
    if (init?.method === "POST" && postMode === "error") { status = 500; data = { error: "Restore unavailable" }; }
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  });
  const Component = which === "settings" ? Members : which === "activity" ? Activity : Trash;
  const params = Promise.resolve({ id: "fixture" });
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(Component, { params })); });
}
async function click(text: string) { await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === text)!.click()); }
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); });
it("Settings preserves role and lifecycle boundaries for Editor and archived Leader", async () => {
  await mount("settings", "EDITOR");
  expect(document.querySelector('h1')!.textContent).toBe("Settings");
  expect(document.querySelector('[aria-label="Role of Editor"]')).toBeNull();
  expect([...document.querySelectorAll('button')].some(b => /Remove|Change leader|Reclassify|Archive/.test(b.textContent ?? ""))).toBe(false);
});
it("Settings retains current retired classification and confirms Viewer handover before writing", async () => {
  await mount("settings");
  expect(document.querySelector('.settings-classification')!.textContent).toContain("Old vertical (retired)");
  expect(document.querySelector('.settings-classification')!.textContent).not.toContain("Other retired");
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Role of Editor"]')!;
  await act(async () => { select.value = "VIEWER"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(document.body.textContent).toContain("Make Editor a Viewer?");
  expect(document.body.textContent).toContain("Who takes their tasks?");
  expect(calls.some(c => c.init?.method === "PATCH")).toBe(false);
});
it("Activity keeps deleted-task Undo and too-old labels hidden for unknown or Editor role", () => {
  const deleted = { kind: "task.deleted", what: 'moved "Task" to Trash', undo: "available" as const };
  expect(showUndo(deleted, undefined)).toBe(false); expect(showUndo(deleted, "EDITOR")).toBe(false); expect(showUndo(deleted, "LEADER")).toBe(true);
  expect(showTooOld({ ...deleted, undo: "too_old" }, undefined)).toBe(false);
  expect(showTooOld({ ...deleted, undo: "too_old" }, "LEADER")).toBe(true);
});
it("Activity gates deletion Undo by kind even when display copy changes or mimics a delete", () => {
  const renamedDelete = { kind: "task.deleted", what: "Task removed", undo: "available" as const };
  expect(showUndo(renamedDelete, "EDITOR")).toBe(false);
  expect(showUndo(renamedDelete, "LEADER")).toBe(true);
  expect(showTooOld({ ...renamedDelete, undo: "too_old" }, "EDITOR")).toBe(false);
  const sectionMove = { kind: "task.moved", what: 'moved "Task" to Trash', undo: "available" as const };
  expect(showUndo(sectionMove, "EDITOR")).toBe(true);
  expect(showTooOld({ ...sectionMove, undo: "too_old" }, "EDITOR")).toBe(true);
});
it("Activity offers no Undo until the API supplies its event kind", () => {
  expect(showUndo({ what: "Unknown event", undo: "available" }, "EDITOR")).toBe(false);
  expect(showTooOld({ what: "Unknown event", undo: "too_old" }, "EDITOR")).toBe(false);
});
it("Activity uses existing Undo request and resets loaded pagination on undone event", async () => {
  await mount("activity"); await click("Undo"); expect(undo).toHaveBeenCalledWith("a");
  await click("Load more"); expect(document.body.textContent).toContain("page two");
  await act(async () => { window.dispatchEvent(new Event("sho:undone", { cancelable: true })); });
  expect(document.body.textContent).not.toContain("page two");
  expect(document.body.textContent).toContain("via concierge");
});
it("Trash exposes full parent context, absent-actor fallback and singular days", async () => {
  await mount("trash", "VIEWER");
  expect(document.body.textContent).toContain("Subtask of Full parent title");
  expect(document.body.textContent).toContain("1 day left");
  expect([...document.querySelectorAll('button')].some(b => b.textContent === "Restore")).toBe(false);
});
it("Trash confirms both actual names before restoring a parent and reports errors", async () => {
  await mount("trash"); postMode = "parent"; await click("Restore");
  expect(document.body.textContent).toContain('Restore both "Full parent title" and "Full child title"?');
  expect(calls.filter(c => c.init?.method === "POST").map(c => JSON.parse(String(c.init!.body)).confirmParent)).toEqual([false]);
  postMode = "error"; await click("Restore both");
  expect(document.querySelector('[role="alert"]')!.textContent).toBe("Restore unavailable");
});
it("archived Leader cannot restore", async () => {
  await mount("trash", "LEADER", true);
  expect([...document.querySelectorAll('button')].some(b => b.textContent === "Restore")).toBe(false);
});
