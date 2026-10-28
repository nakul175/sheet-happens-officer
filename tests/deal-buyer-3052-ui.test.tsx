// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangeDealBuyer } from "@/components/ChangeDealBuyer";
const m = vi.hoisted(() => ({ api: vi.fn(), useGet: vi.fn(), organisations: [{ id: "old", name: "Old Buyer" }, { id: "new", name: "New Buyer" }] }));
vi.mock("@/components/api", () => ({ api: m.api, useGet: m.useGet }));
vi.mock("@/components/ui", async () => {
  const React = await import("react");
  return { Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>, Field: ({ label, children }: { label: string; children: (id: string) => React.ReactNode }) => { const id = React.useId(); return <label htmlFor={id}>{label}{children(id)}</label>; } };
});
let root: Root;
const done = vi.fn(), close = vi.fn();
async function mount() { await act(async () => root.render(<ChangeDealBuyer projectId="deal" buyer={{ id: "old", name: "Old Buyer" }} onDone={done} onClose={close} />)); }
async function chooseNew() { await act(async () => { const select = document.querySelector("select")!; select.value = "new"; select.dispatchEvent(new Event("change", { bubbles: true })); }); }
async function submit() { await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; document.body.innerHTML = '<div id="root"></div>'; root = createRoot(document.getElementById("root")!); m.api.mockReset(); m.organisations = [{ id: "old", name: "Old Buyer" }, { id: "new", name: "New Buyer" }]; m.useGet.mockReset(); m.useGet.mockImplementation(() => ({ loading: false, error: null, data: { organisations: m.organisations } })); done.mockReset(); close.mockReset(); });
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });
it("requires a changed existing Account and sends the stale-write guard", async () => {
  m.api.mockResolvedValue({ ok: true }); await mount();
  expect(document.querySelector<HTMLButtonElement>('button[form]')!.disabled).toBe(true);
  expect(document.querySelectorAll("select option")).toHaveLength(2);
  await chooseNew(); await submit();
  expect(m.api).toHaveBeenCalledWith("PATCH", "/api/projects/deal/buyer", { organisationId: "new", expectedOrganisationId: "old" });
  expect(done).toHaveBeenCalledOnce();
});
it("keeps selection and dialog on a stale conflict and does not claim success", async () => {
  m.api.mockResolvedValue({ ok: false, error: "The Buyer changed. Refresh the deal." }); await mount(); await chooseNew(); await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Refresh the deal");
  expect(document.querySelector("select")!.value).toBe("new"); expect(done).not.toHaveBeenCalled();
});
it("Cancel makes no API request", async () => {
  await mount(); await chooseNew();
  act(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click());
  expect(close).toHaveBeenCalledOnce(); expect(m.api).not.toHaveBeenCalled();
});
it("network failure preserves selection and enables retry", async () => {
  m.api.mockRejectedValue(new Error("offline")); await mount(); await chooseNew(); await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("try again");
  expect(document.querySelector<HTMLButtonElement>('button[form]')!.disabled).toBe(false); expect(done).not.toHaveBeenCalled();
});

it("searches the server beyond the first 500 Accounts and retains a selected Account across searches", async () => {
  await mount();
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  async function searchFor(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  m.organisations = [{ id: "beyond-500", name: "ZZ Remote Account" }];
  await searchFor(" ZZ Remote & Account ");
  expect(m.useGet).toHaveBeenLastCalledWith("/api/orgs?q=ZZ%20Remote%20%26%20Account");
  await act(async () => { const select = document.querySelector("select")!; select.value = "beyond-500"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  m.organisations = [];
  await searchFor("different");
  expect(document.querySelector("select")!.value).toBe("beyond-500");
  expect(document.querySelector("select")!.selectedOptions[0].textContent).toBe("ZZ Remote Account (selected)");
  m.api.mockResolvedValue({ ok: true });
  await submit();
  expect(m.api).toHaveBeenCalledWith("PATCH", "/api/projects/deal/buyer", { organisationId: "beyond-500", expectedOrganisationId: "old" });
});
