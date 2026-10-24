// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskModal } from "@/components/TaskModal";
const mock = vi.hoisted(() => ({ api: vi.fn(), task: {} as Record<string, unknown>, role: "LEADER" }));
vi.mock("@/components/api", () => ({ PRIORITY: { MEDIUM: "Medium" }, ROLE: {}, dueLabel: (s: string) => s, api: mock.api, useGet: (url: string) => ({ loading: false, reload: vi.fn(), data: url?.startsWith("/api/tasks/") ? { task: mock.task } : { project: { role: mock.role, members: [{ userId: "me", name: "Leader", role: "LEADER", active: true }, { userId: "editor", name: "Editor", role: "EDITOR", active: true }, { userId: "viewer", name: "Viewer", role: "VIEWER", active: true }, { userId: "inactive", name: "Inactive", role: "EDITOR", active: false }], sections: [] } } }) }));
vi.mock("@/app/(app)/Shell", () => ({ useMe: () => ({ id: "me" }) }));
vi.mock("@/components/ConvertDialog", () => ({ ConvertDialog: () => null }));
vi.mock("@/components/TaskLinks", () => ({ TaskLinks: () => null }));
vi.mock("@/components/Comments", () => ({ Comments: () => null }));
let root: Root;
beforeEach(() => { document.body.innerHTML = '<div id="root"></div>'; root = createRoot(document.getElementById("root")!); mock.role = "LEADER"; mock.api.mockReset().mockResolvedValue({ ok: true, data: {} }); mock.task = { id: "t", projectId: "p", parentId: null, createdById: "me", createdBy: { name: "Original creator" }, createdAt: "2026-10-24T00:00:00Z", title: "Parent", dueDate: "2026-10-25", priority: "MEDIUM", completedAt: null, assignee: { id: "me", name: "Leader" }, approver: null, collaborators: [], updatedAt: "version", canClose: true, project: { id: "p", name: "Project", archived: false }, section: { id: "s", name: "Todo" }, subtaskList: [] }; });
afterEach(() => act(() => root.unmount()));
const render = () => act(() => root.render(<TaskModal id="t" me="me" asPage onClose={() => {}} />));
it("offers other eligible project assignees and active member collaborators", () => { render(); const assignee = document.querySelector<HTMLSelectElement>('[aria-label="Assignee"]')!; expect(Array.from(assignee.options, (o) => o.value)).toEqual(["me", "editor"]); const collab = document.querySelector<HTMLSelectElement>('[aria-label="Add a collaborator"]')!; expect(Array.from(collab.options, (o) => o.value)).toEqual(["", "editor", "viewer"]); });
it("shows immutable creator name and explicit IST creation time with safe former-member fallback", () => { render(); expect(document.body.textContent).toContain("Original creator"); expect(document.querySelector("time")?.dateTime).toBe("2026-10-24T00:00:00Z"); expect(document.querySelector("time")?.textContent).toContain("05:30 IST"); mock.task = { ...mock.task, createdBy: null }; render(); expect(document.body.textContent).toContain("Former member"); });
it("warns without blocking creation when optional subtask due date exceeds parent", async () => { render(); const input = document.querySelector<HTMLInputElement>('[aria-label="Subtask due date"]')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2026-10-26"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); }); expect(document.body.textContent).toContain("You can still add it.");
  const title = document.querySelector<HTMLInputElement>('[aria-label="New subtask"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Follow up"); title.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => title.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mock.api).toHaveBeenCalledWith("POST", "/api/projects/p/tasks", { title: "Follow up", parentId: "t", dueDate: "2026-10-26" });
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Subtask assignee"]')!.options.length).toBe(3); // default + two eligible members
  // A subtask detail re-evaluates the warning using the current persisted parent date.
  mock.task = { ...mock.task, parentId: "parent", parentDueDate: "2026-10-24" }; render(); expect(document.body.textContent).toContain("This subtask is due after its parent task."); expect(document.querySelector<HTMLInputElement>('[aria-label="Due date"]')).not.toBeNull(); });
it("does not offer write controls to Viewers", () => { mock.role = "VIEWER"; render(); expect(document.querySelector('[aria-label="Subtask assignee"]')).toBeNull(); expect(document.querySelector('[aria-label="Add a collaborator"]')).toBeNull(); });
