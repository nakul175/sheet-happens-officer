/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskModal } from "@/components/TaskModal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children }: { href: string; children?: React.ReactNode }) => React.createElement("a", { href }, children) };
});
vi.mock("@/app/(app)/Shell", () => ({ useMe: () => ({ id: "lead", orgRole: "MEMBER" }) }));

const task = {
  id: "task-3058", projectId: "project-3058", parentId: null, createdById: "lead", title: "Assign me", description: null,
  priority: "MEDIUM", dueDate: null, blocked: false, blockedReason: null, completedAt: null, assignee: { id: "lead", name: "Leader" },
  approver: null, collaborators: [], awaitingApproval: false, updatedAt: "2026-10-29T03:00:00.000Z", canClose: true,
  section: { id: "todo", name: "To do", isDone: false }, project: { id: "project-3058", name: "Project", archived: false },
  subtaskList: [], links: [], commentsEnabled: false,
};

function project(role: "LEADER" | "EDITOR") {
  return { id: "project-3058", role, archived: false, sections: [task.section], members: [{ userId: "lead", name: "Leader", role, active: true }] };
}

let root: Root | undefined;
async function flush() {
  for (let i = 0; i < 15; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function render(role: "LEADER" | "EDITOR") {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let body: unknown = {};
    if (method === "GET" && url === "/api/tasks/task-3058") body = { task };
    else if (method === "GET" && url === "/api/projects/project-3058") body = { project: project(role) };
    else if (method === "GET" && url.includes("/people?q=")) body = { canAdd: true, people: [{ id: "new-person", name: "Alex Duplicate", email: "alex.duplicate@aplyd.com", memberRole: null }] };
    return new Response(JSON.stringify(body), { status: method === "POST" ? 200 : 200, headers: { "content-type": "application/json" } });
  }));
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<TaskModal id="task-3058" me="lead" onClose={() => undefined} />); });
  await flush();
  return calls;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SHO-3058 task modal", () => {
  it("makes a Leader search, identify by email, then explicitly add as Editor and assign", async () => {
    const calls = await render("LEADER");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search workspace people"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "alex");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { document.querySelector<HTMLFormElement>("form.addrow")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    expect(document.body.textContent).toContain("alex.duplicate@aplyd.com");
    const button = [...document.querySelectorAll("button")].find((x) => x.textContent === "Add as Editor and assign")!;
    await act(async () => { button.click(); });
    await flush();
    expect(calls.find((x) => x.method === "POST" && x.url.endsWith("/assign"))?.body).toEqual({
      assigneeId: "new-person",
      expectedUpdatedAt: task.updatedAt,
      addMemberRole: "EDITOR",
    });
  });

  it("shows an Editor the Leader instruction and no workspace search", async () => {
    await render("EDITOR");
    expect(document.body.textContent).toContain("Ask the project Leader to add someone who is not already a member.");
    expect(document.querySelector('input[aria-label="Search workspace people"]')).toBeNull();
  });
});
