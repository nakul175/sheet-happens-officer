// @vitest-environment jsdom
import { act, Suspense, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OrgView from "@/app/(app)/accounts/[id]/OrgView";

const state = vi.hoisted(() => ({ canEdit: true, archived: false }));
vi.mock("@/components/api", () => ({
  api: vi.fn(), todayIST: () => "2026-10-24", dueLabel: (date: string) => date,
  useGet: () => ({ status: 200, reload: vi.fn(), data: { organisation: {
    id: "org", name: "Account", kind: "Ministry", country: "India", parentId: null, level: null,
    canEdit: state.canEdit, archived: state.archived, createdBy: "Creator", path: [], deals: [], contacts: [], notes: [], tasks: [], tree: null,
  } } }),
}));
vi.mock("@/app/(app)/Shell", () => ({
  useMe: () => ({ id: "viewer", orgRole: "MEMBER" }),
  Page: ({ actions, children }: { actions: ReactNode; children: ReactNode }) => <main>{actions}{children}</main>,
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/components/ui", () => ({ Confirm: () => null, Field: () => null, Modal: () => null }));
vi.mock("@/app/(app)/accounts/OrgDialog", () => ({ default: () => <div role="dialog">Edit organisation</div> }));
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  state.canEdit = true; state.archived = false;
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });
async function mount() {
  const params = Promise.resolve({ id: "org" });
  await act(async () => root.render(<Suspense fallback="Loading"><OrgView params={params} /></Suspense>));
}
it("offers authorised active accounts an edit action and opens their details dialog", async () => {
  await mount();
  const edit = [...document.querySelectorAll("button")].find((b) => b.textContent === "Edit details");
  expect(edit).toBeDefined();
  act(() => edit!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toBe("Edit organisation");
});
it("does not expose organisation editing to other workspace Members", async () => {
  state.canEdit = false;
  await mount();
  expect(document.body.textContent).not.toContain("Edit details");
  expect(document.body.textContent).not.toContain("Archive");
});
it("keeps archived organisations read-only and retains Unarchive for their authorised owner", async () => {
  state.archived = true;
  await mount();
  expect(document.body.textContent).not.toContain("Edit details");
  expect(document.body.textContent).toContain("Unarchive");
});
