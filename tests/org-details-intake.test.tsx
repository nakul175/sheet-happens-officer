// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OrgDialog from "@/app/(app)/accounts/OrgDialog";
import { ORGANISATION_KINDS, organisationKindOptions } from "@/lib/org-kinds";

const mocks = vi.hoisted(() => ({ api: vi.fn(), parents: [{ id: "parent", name: "Parent account" }] }));
vi.mock("@/components/api", () => ({ api: mocks.api, useGet: () => ({ data: { organisations: mocks.parents } }) }));
// Exercise the real form controls and API requests without unrelated sheet viewport effects.
vi.mock("@/components/ui", async () => {
  const React = await import("react");
  return {
    Modal: ({ children, label }: { children: React.ReactNode; label: string }) => <div role="dialog" aria-label={label}>{children}</div>,
    Field: ({ label, children }: { label: string; children: (id: string) => React.ReactNode }) => {
      const id = React.useId();
      return <div><label htmlFor={id}>{label}</label>{children(id)}</div>;
    },
  };
});
let root: Root;
const organisation = { id: "org", name: "Existing account", kind: "Legacy company", country: "India", level: "LEGAL_ENTITY" as const, parentId: "parent", path: [{ id: "parent", name: "Parent account" }, { id: "org", name: "Existing account" }] };
function field(label: string): HTMLInputElement | HTMLSelectElement {
  const id = [...document.querySelectorAll("label")].find((l) => l.textContent === label)!.htmlFor;
  return document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
}
function change(label: string, value: string) {
  const input = field(label);
  act(() => {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function click(label: string) {
  await act(async () => { [...document.querySelectorAll("button")].find((b) => b.textContent === label)!.click(); });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  mocks.api.mockReset();
  mocks.parents = [{ id: "parent", name: "Parent account" }];
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });

describe("SHO-3039 / SHO-3046 organisation create and edit", () => {
  it("offers the eight canonical kinds and retains a legacy value without remapping", () => {
    expect(ORGANISATION_KINDS).toEqual(["Donor", "Ministry", "Public Institution", "Multilateral", "Implementation Partner", "Academic Institution", "Private Institution", "Others"]);
    expect(organisationKindOptions("Ministry")).toHaveLength(8);
    act(() => root.render(<OrgDialog organisation={organisation} onClose={() => {}} onDone={() => {}} />));
    const kind = field("Kind (optional)") as HTMLSelectElement;
    expect(kind.value).toBe("Legacy company");
    expect([...kind.options].map((o) => o.value)).toEqual(["", "Legacy company", ...ORGANISATION_KINDS]);
  });
  it("edits through PATCH without replacing the organisation or its hierarchy IDs", async () => {
    mocks.api.mockResolvedValue({ ok: true });
    const done = vi.fn();
    act(() => root.render(<OrgDialog organisation={organisation} onClose={() => {}} onDone={done} />));
    change("Name", "Revised account");
    change("Kind (optional)", "Others");
    await click("Save");
    expect(mocks.api).toHaveBeenCalledWith("PATCH", "/api/orgs/org", { name: "Revised account", kind: "Others", country: "India", parentId: "parent", level: "LEGAL_ENTITY" });
    expect(done).toHaveBeenCalledWith("org");
  });
  it("preserves an existing parent absent from the active parent list", async () => {
    mocks.parents = [];
    mocks.api.mockResolvedValue({ ok: true });
    act(() => root.render(<OrgDialog organisation={organisation} onClose={() => {}} onDone={() => {}} />));
    expect(field("Sits under (optional)").value).toBe("parent");
    await click("Save");
    expect(mocks.api.mock.calls[0][2]).toMatchObject({ parentId: "parent", level: "LEGAL_ENTITY", kind: "Legacy company" });
  });
  it("keeps optional classification empty and preserves duplicate-create confirmation", async () => {
    mocks.api.mockResolvedValueOnce({ ok: false, data: { needsConfirm: "duplicate" }, error: "Already exists" }).mockResolvedValueOnce({ ok: true, data: { organisation: { id: "new" } } });
    act(() => root.render(<OrgDialog onClose={() => {}} onDone={() => {}} />));
    change("Name", "New account");
    await click("Add");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Already exists");
    expect(field("Name").value).toBe("New account");
    await click("Add anyway");
    expect(mocks.api.mock.calls[1]).toEqual(["POST", "/api/orgs", { name: "New account", kind: null, country: null, parentId: null, level: null, force: true }]);
  });
  it("shows server validation errors without discarding hierarchy or user edits", async () => {
    mocks.api.mockResolvedValue({ ok: false, error: "An organisation cannot sit under itself or under one of its own branches." });
    act(() => root.render(<OrgDialog organisation={organisation} onClose={() => {}} onDone={() => {}} />));
    change("Country", "Sri Lanka");
    await click("Save");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("branches");
    expect(field("Country").value).toBe("Sri Lanka");
    expect(field("Sits under (optional)").value).toBe("parent");
    expect(document.body.textContent).not.toContain("Add anyway");
  });
});
