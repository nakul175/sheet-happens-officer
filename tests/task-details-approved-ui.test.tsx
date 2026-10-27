// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/app/(app)/Shell", () => ({ useMe: () => ({ id: "me", crm: false }) }));
import { TaskModal } from "../src/components/TaskModal";
let root: Root | undefined;
let mode = "ok";
async function mount(role = "LEADER", archived = false, canClose = true, asPage = true) {
  mode = "ok"; document.body.innerHTML = '<div id="root"></div>';
  const task = { id: "task", projectId: "project", parentId: null, createdById: "me", title: "Full task title", description: "Original description", priority: "MEDIUM", dueDate: "2026-10-30", blocked: false, blockedReason: null, completedAt: null, assignee: { id: "worker", name: "Worker" }, approver: { id: "me", name: "Approver Name" }, collaborators: [], awaitingApproval: false, updatedAt: "2026-10-27T00:00:00.000Z", canClose, section: { id: "todo", name: "To do", isDone: false }, project: { id: "project", name: "Full project", archived }, subtaskList: [], commentsEnabled: false };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      const data = mode === "stale" ? { error: { code: "version_conflict", message: "Another person changed this task while you were editing it." } } : mode === "confirm" && !JSON.parse(String(init.body)).completeAll ? { needsConfirm: "open_subtasks", openSubtasks: 2 } : {};
      return new Response(JSON.stringify(data), { status: Object.keys(data).length ? 409 : 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(String(input).includes("/projects/") ? { project: { role, archived, sections: [task.section], members: [{ userId: "worker", name: "Worker", role: "EDITOR", active: true }, { userId: "me", name: "Approver Name", role: "LEADER", active: true }] } } : { task }), { headers: { "content-type": "application/json" } });
  }); globalThis.fetch = fetcher;
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(TaskModal, { id: "task", me: "me", onClose: vi.fn(), asPage })); });
  return fetcher;
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
  const fetcher = await mount(); mode = "confirm";
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
