// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { OrganisationEdit } from "../src/app/(app)/accounts/[id]/OrgView";
import { DeleteProject } from "../src/app/(app)/projects/[id]/members/Members";

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.restoreAllMocks(); document.body.innerHTML = ""; });

it("lets an authorised editor rename a submitted organisation", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  const done = vi.fn();
  const organisation = { id: "org-1", name: "Old client", kind: "Client", country: "India", archived: false, path: [], canEdit: true, createdBy: null, deals: [], contacts: [], notes: [], tree: null, tasks: [] };
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(OrganisationEdit, { organisation, onClose: vi.fn(), onDone: done })); });
  const name = document.querySelector<HTMLInputElement>('input[value="Old client"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Renamed client"); name.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { [...document.querySelectorAll("button")].find(b => b.textContent === "Save changes")!.click(); });
  expect(fetcher).toHaveBeenCalledWith("/api/orgs/org-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Renamed client", kind: "Client", country: "India" }) }));
  expect(done).toHaveBeenCalledOnce();
});

it("uses the recoverable workflow for a deal", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(DeleteProject, { id: "deal-1", name: "Bid One", kind: "deal", onClose: vi.fn() })); });
  expect(document.body.textContent).toContain("Delete deal “Bid One”?");
  expect(document.body.textContent).toContain("Deals → Trash");
});

it("offers an explicit subtask Trash control backed by the task delete API", async () => {
  const source = await readFile(path.resolve(process.cwd(), "src/components/TaskModal.tsx"), "utf8");
  expect(source).toContain('aria-label={`Move subtask "${s.title}" to Trash`}');
  expect(source).toContain('api("DELETE", `/api/tasks/${trashSub.id}`)');
  expect(source).toContain("kept for 30 days");
});
