// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ children, actions }: { children: React.ReactNode; actions: React.ReactNode }) => h("div", null, actions, children), useMe: () => ({ orgRole: "ADMIN" }) }));
import ProjectsView from "../src/app/(app)/projects/ProjectsView";
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); });
it("separates vertical boards, linked delivery and unclassified legacy records", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const project = { description: null, archived: false, myRole: "LEADER", openTasks: 0, leader: { name: "Leader" } };
  globalThis.fetch = vi.fn(async input => {
    const path = String(input);
    const data = path === "/api/projects" ? { projects: [{ ...project, id: "board", name: "Growth board", isVertical: true }, { ...project, id: "delivery", name: "Client delivery", vertical: { id: "board", name: "Growth" } }, { ...project, id: "legacy", name: "Legacy unclassified" }] } : path === "/api/verticals" ? { verticals: [{ id: "board", name: "Growth" }], suggestions: ["Growth", "Marketing", "Founder's Office"] } : { projects: [] };
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  });
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(ProjectsView)); });
  expect(document.querySelector('a[href="/projects/delivery"]')).not.toBeNull();
  expect(document.querySelector('a[href="/projects/legacy"]')).not.toBeNull();
  expect(document.querySelector('a[href="/projects/board"]')).toBeNull();
  const select = document.querySelector<HTMLSelectElement>("select")!;
  await act(async () => { select.value = "unclassified"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(document.querySelector('a[href="/projects/delivery"]')).toBeNull();
  expect(document.querySelector('a[href="/projects/legacy"]')).not.toBeNull();
  await act(async () => { [...document.querySelectorAll("button")].find(b => b.textContent === "Vertical task boards")!.click(); });
  expect(document.querySelector('a[href="/projects/board"]')).not.toBeNull();
  expect(document.querySelector('a[href="/projects/legacy"]')).toBeNull();
});
