// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
let role = "SUPER_ADMIN";
vi.mock("@/app/(app)/Shell", () => ({ Page: ({ children, actions }: { children: React.ReactNode; actions: React.ReactNode }) => h("main", null, actions, children), useMe: () => ({ id: "self", orgRole: role }), roleLabel: (s: string) => s }));
import Team from "../src/app/(app)/team/Team";
let root: Root | undefined;
const people = [{ id: "self", name: "Self", email: "self@example.test", orgRole: "SUPER_ADMIN", status: "ACTIVE", leads: [] }, { id: "member", name: "Member", email: "member@example.test", orgRole: "MEMBER", status: "ACTIVE", leads: [{ id: "p", name: "Actual project" }] }, { id: "admin", name: "Admin", email: "admin@example.test", orgRole: "ADMIN", status: "ACTIVE", leads: [] }, { id: "inactive", name: "Inactive", email: "inactive@example.test", orgRole: "MEMBER", status: "DEACTIVATED", leads: [] }];
async function mount(override = people) { document.body.innerHTML = '<div id="root"></div>'; vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ people: role === "MEMBER" ? [{ id: "member", name: "Member" }] : override }), { headers: { "content-type": "application/json" } })); await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(Team)); }); }
const row = (name: string) => [...document.querySelectorAll('tbody tr')].find(r => r.textContent!.includes(name))!;
afterEach(() => { act(() => root?.unmount()); root = undefined; role = "SUPER_ADMIN"; vi.restoreAllMocks(); });
it("keeps Member view private with no management controls", async () => { role = "MEMBER"; await mount(); expect(document.body.textContent).not.toContain("@"); expect(document.querySelector('table')).toBeNull(); expect(document.querySelector('details')).toBeNull(); expect(document.querySelector('button')).toBeNull(); });
it("groups only existing SuperAdmin controls and protects their own row", async () => { await mount(); expect(row("Self").querySelector('details')).toBeNull(); const member = row("member@example.test"); expect(member.querySelector('summary')!.getAttribute('aria-label')).toBe("More actions for Member"); expect(member.textContent).toContain("Make Admin"); expect(member.textContent).toContain("Resend sign-in details"); expect(member.querySelector('a[href="/projects/p"]')).not.toBeNull(); expect(row("inactive@example.test").textContent).toContain("Reactivate"); });
it("Admin cannot change roles, resend credentials or deactivate another Admin", async () => { role = "ADMIN"; await mount(); expect(document.body.textContent).not.toContain("Add person"); expect(document.body.textContent).not.toContain("Resend sign-in details"); expect(row("admin@example.test").textContent).not.toContain("Deactivate"); expect(row("member@example.test").textContent).toContain("Deactivate"); expect(row("member@example.test").textContent).not.toContain("Make Admin"); });

it("keeps every led project reachable behind a bounded disclosure", async () => {
  const leads = Array.from({ length: 18 }, (_, i) => ({ id: `lead-${i}`, name: `Long project ${i}` }));
  await mount([{ ...people[1], leads }]);
  const member = row("member@example.test");
  const list = member.querySelector('.team-leads')!;
  expect(list.querySelectorAll(':scope > a')).toHaveLength(2);
  const disclosure = list.querySelector('details')!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector('summary')?.getAttribute('aria-label')).toBe('Show 16 more projects led by Member');
  expect(disclosure.querySelectorAll('a')).toHaveLength(16);
  await act(async () => { disclosure.querySelector('summary')!.click(); });
  expect(disclosure.open).toBe(true);
  expect([...list.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual(leads.map(p => `/projects/${p.id}`));
});
