// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/app/(app)/Shell", () => ({ useMe: () => ({ id: "me", crm: false }) }));
import { TaskModal } from "../src/components/TaskModal";
let root: Root | undefined;
let mode = "ok";
async function mount(role = "LEADER", archived = false, canClose = true, asPage = true, initial: "ok" | "loading" | "missing" = "ok") {
  mode = "ok"; document.body.innerHTML = '<button id="opener">Open task</button><div id="root"></div>';
  const opener = document.getElementById("opener")!;
  opener.focus();
  const task = { id: "task", projectId: "project", parentId: null, createdById: "me", title: "Full task title", description: "Original description", priority: "MEDIUM", dueDate: "2026-10-30", blocked: false, blockedReason: null, completedAt: null, assignee: { id: "worker", name: "Worker" }, approver: { id: "me", name: "Approver Name" }, collaborators: [], awaitingApproval: false, updatedAt: "2026-10-27T00:00:00.000Z", canClose, section: { id: "todo", name: "To do", isDone: false }, project: { id: "project", name: "Full project", archived }, subtaskList: [], commentsEnabled: false };
  let waiting = initial === "loading";
  let resolveTask: (response: Response) => void = () => {};
  const pending = waiting ? new Promise<Response>(resolve => { resolveTask = resolve; }) : null;
  const onClose = vi.fn();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      const data = mode === "stale" ? { error: { code: "version_conflict", message: "Another person changed this task while you were editing it." } } : mode === "confirm" && !JSON.parse(String(init.body)).completeAll ? { needsConfirm: "open_subtasks", openSubtasks: 2 } : {};
      return new Response(JSON.stringify(data), { status: Object.keys(data).length ? 409 : 200, headers: { "content-type": "application/json" } });
    }
    if (String(input) === "/api/tasks/task") {
      if (waiting) return pending!;
      if (initial === "missing") return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(String(input).includes("/projects/") ? { project: { role, archived, sections: [task.section], members: [{ userId: "worker", name: "Worker", role: "EDITOR", active: true }, { userId: "me", name: "Approver Name", role: "LEADER", active: true }] } } : { task }), { headers: { "content-type": "application/json" } });
  }); globalThis.fetch = fetcher;
  function Fixture() {
    const [open, setOpen] = useState(true);
    return open ? h(TaskModal, { id: "task", me: "me", onClose: () => { onClose(); setOpen(false); }, asPage }) : null;
  }
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(Fixture)); });
  return { fetcher, onClose, opener, releaseTask: () => { waiting = false; resolveTask(new Response(JSON.stringify({ task }), { headers: { "content-type": "application/json" } })); } };
}
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); });
it("keeps Approver and every editable detail, title limit and separate main/detail panels", async () => {
  await mount();
  expect(document.querySelector('.task-main-panel textarea#desc')).not.toBeNull();
  expect(document.querySelector('.task-details-panel select[aria-label="Approver"]')).not.toBeNull();
  for (const label of ["Assignee", "Due date", "Section", "Priority"]) expect(document.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Title"]')!.maxLength).toBe(500);
  expect(document.body.textContent).toContain("Clear");
});
it("keeps open-subtask confirmation and versioned completion payload", async () => {
  const { fetcher } = await mount(); mode = "confirm";
  await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === "Close task")!.click());
  expect(document.body.textContent).toContain("2 open subtasks");
  await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === "Complete them all")!.click());
  const calls = fetcher.mock.calls.filter(([,init]) => init?.method === "POST");
  expect(calls).toHaveLength(2);
  expect(JSON.parse(String(calls[1][1]!.body))).toEqual({ completeAll: true, expectedUpdatedAt: "2026-10-27T00:00:00.000Z" });
});
it("retains stale description and exposes reapply recovery", async () => {
  await mount(); mode = "stale";
  const description = document.querySelector<HTMLTextAreaElement>('#desc')!;
  await act(async () => { description.value = "Unsaved new description"; description.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  expect(document.body.textContent).toContain("Your edit was: Description");
  expect([...document.querySelectorAll('button')].some(b => b.textContent === "Re-apply my edit")).toBe(true);
});
it("archived Viewer modal keeps read-only details and no completion or Trash actions", async () => {
  await mount("VIEWER", true, false, false);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Title"]')!.readOnly).toBe(true);
  expect(document.body.textContent).toContain("Approver Name");
  expect([...document.querySelectorAll('button')].some(b => /Close task|Mark complete|Move to Trash/.test(b.textContent ?? ""))).toBe(false);
});
it.each(["loading", "missing"] as const)("offers Close while the task is %s", async initial => {
  const { onClose, opener } = await mount("LEADER", false, true, false, initial);
  const close = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "Close");
  expect(close).toBeDefined();
  await act(async () => close!.click());
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
it("returns focus to the task opener after loading finishes", async () => {
  const { releaseTask, opener } = await mount("LEADER", false, true, false, "loading");
  await act(async () => releaseTask());
  expect(document.querySelector('[aria-label="Title"]')).not.toBeNull();
  const close = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "Close")!;
  await act(async () => close.click());
  expect(document.activeElement).toBe(opener);
});
it.each(["Close", "Escape"])("asks before %s loses an unblurred description", async control => {
  const { onClose } = await mount("LEADER", false, true, false);
  document.querySelector<HTMLTextAreaElement>('#desc')!.value = "Draft still being edited";
  await act(async () => {
    if (control === "Escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === "Close")!.click();
  });
  expect(onClose).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Close without saving?");
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === "Cancel")!.click());
  expect(document.querySelector<HTMLTextAreaElement>('#desc')!.value).toBe("Draft still being edited");
  expect(document.body.classList.contains("vv-sheet")).toBe(true);
});
it("warns before closing a refused stale edit and permits an explicit exit", async () => {
  const { onClose } = await mount("LEADER", false, true, false); mode = "stale";
  const description = document.querySelector<HTMLTextAreaElement>('#desc')!;
  await act(async () => { description.value = "Refused draft"; description.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === "Close")!.click());
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === "Close anyway")!.click());
  expect(onClose).toHaveBeenCalledOnce();
});
