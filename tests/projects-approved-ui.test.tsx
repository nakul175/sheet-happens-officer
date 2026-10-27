// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const state = vi.hoisted(() => ({ orgRole: "ADMIN" }));
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ children, actions }: { children: React.ReactNode; actions: React.ReactNode }) => h("main", null, actions, children), useMe: () => state }));
import ProjectsView from "../src/app/(app)/projects/ProjectsView";
let root: Root | undefined;
const longName = "INV-104889 — Full investment name with every original word preserved — ".repeat(5);
const defaults = { description: null, archived: false, myRole: "EDITOR", openTasks: 2, leader: null };
const delivery = { ...defaults, id: "delivery", name: longName, vertical: { id: "growth", name: "Growth", retired: true } };
const board = { ...defaults, id: "board", name: "Growth board", isVertical: true };
const archived = { ...defaults, id: "archived", name: "Archived delivery", archived: true };
async function mount(role = "ADMIN", error = false) {
  state.orgRole = role;
  document.body.innerHTML = '<div id="root"></div>';
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST") return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } });
    const data = path === "/api/projects" ? { projects: [delivery, board, { ...defaults, id: "other", name: "Other project", myRole: null }] } : path.includes("archived=true") ? { projects: [archived] } : path.includes("deleted=true") ? { projects: [{ ...defaults, id: "trash", name: "Recoverable project" }] } : { verticals: [{ id: "growth", name: "Growth", retired: true }] };
    return new Response(JSON.stringify(error && path === "/api/projects" ? { error: "Unavailable" } : data), { status: error && path === "/api/projects" ? 503 : 200, headers: { "content-type": "application/json" } });
  });
  globalThis.fetch = fetcher;
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(ProjectsView)); });
  return fetcher;
}
async function click(text: string) { await act(async () => { [...document.querySelectorAll("button")].find(b => b.textContent === text)!.click(); }); }
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); });
it("keeps the desktop navigation at content height on short project screens", () => {
  const css = readFileSync("src/app/(app)/nav-header.css", "utf8");
  expect(css).toMatch(/\.shell\.shell\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,1fr\)/s);
});
it("keeps full stored names, classification, absent-data fallbacks and explicit task counts", async () => {
  await mount();
  const card = document.querySelector('a[href="/projects/delivery"]')!;
  expect(card.querySelector("h2")!.textContent).toBe(longName);
  expect(card.textContent).toContain("Growth (retired)");
  expect(card.textContent).toContain("No description");
  expect(card.textContent).toContain("Leader: none");
  expect(card.textContent).toContain("You: Editor");
  expect(card.textContent).toContain("2 open tasks");
  expect(document.querySelector('a[href="/projects/archived"]')!.textContent).toContain("Read-only");
});
it("groups Mine/All with accurate counts and retains classification filtering", async () => {
  await mount();
  expect(document.querySelector('[role="status"]')!.textContent).toBe("1 project");
  await click("All projects");
  expect(document.querySelector('[role="status"]')!.textContent).toBe("2 projects");
  const select = document.querySelector("select")!;
  await act(async () => { select.value = "unclassified"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(document.querySelector('a[href="/projects/delivery"]')).toBeNull();
  expect(document.querySelector('a[href="/projects/other"]')).not.toBeNull();
});
it("selects boards without a classification filter and makes authorized create primary", async () => {
  await mount(); await click("Vertical task boards");
  expect(document.querySelector("select")).toBeNull();
  expect(document.querySelector('a[href="/projects/board"]')).not.toBeNull();
  expect(document.querySelector('a[href="/projects/delivery"]')).toBeNull();
  const create = [...document.querySelectorAll("button")].find(b => b.textContent === "+ New vertical")!;
  expect(create.classList.contains("ghost")).toBe(false);
  expect(document.querySelector('[role="status"]')!.textContent).toBe("1 board");
  await click("+ New vertical");
  expect(document.querySelector('input[maxlength="200"]')).not.toBeNull();
  expect([...document.querySelectorAll("button")].find(b => b.textContent === "Create vertical")!.disabled).toBe(true);
});
it("does not expose Admin create or All controls to Members and keeps permitted New project", async () => {
  await mount("MEMBER");
  expect(document.querySelector('[aria-label="Which projects"]')).toBeNull();
  expect([...document.querySelectorAll("button")].some(b => b.textContent === "+ New vertical")).toBe(false);
  expect(document.querySelector('a[href="/projects/new"]')).not.toBeNull();
});
it("retains global recoverable Trash across tabs and confirms before restore", async () => {
  const fetcher = await mount(); await click("Vertical task boards");
  expect(document.querySelector('[aria-label="Project Trash"]')!.textContent).toContain("Recoverable project");
  await click("Restore project…");
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  await click("Restore project");
  expect(fetcher.mock.calls.some(([path, init]) => path === "/api/projects/trash/restore" && init?.method === "POST")).toBe(true);
});
it("shows retriable server failure without claiming no access", async () => {
  await mount("MEMBER", true);
  expect(document.body.textContent).toContain("Retry");
  expect(document.body.textContent).not.toContain("Ask a project Leader to add you.");
});
