// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => h("a", props, children) }));
vi.mock("@/components/api", () => ({ api: mocks.api, ago: () => "just now" }));
import { Bell } from "@/app/(app)/Bell";
let root: Root | undefined;
const generic = "A deal you can't view was updated.";
const notice = (id: string) => ({ id, text: generic, href: null, read: false, createdAt: "2026-10-28T00:00:00Z" });
async function mount() {
  document.body.innerHTML = '<div id="root"></div>';
  mocks.api.mockImplementation(async (_method: string, url: string) => ({ ok: true, data: { unread: 2, items: [notice(url.includes("before=") ? "older" : "newer")], next: url.includes("before=") ? null : "cursor|newer" } }));
  await act(async () => { root = createRoot(document.getElementById("root")!); root.render(h(Bell)); });
  await act(async () => document.querySelector<HTMLButtonElement>('.bell')!.click());
}
async function click(label: string) { await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!.click()); }
afterEach(() => { act(() => root?.unmount()); root = undefined; mocks.api.mockReset(); mocks.push.mockReset(); document.body.innerHTML = ""; });
it("qa:TC missing SHO-2727: a redacted null-href notice has no link or navigation/read side effect when its text is clicked", async () => {
  await mount();
  const main = document.querySelector<HTMLElement>('.bell-main')!;
  expect(main.textContent).toContain(generic); expect(main.tagName).toBe("DIV"); expect(document.querySelector('a')).toBeNull();
  await act(async () => main.click());
  expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.api.mock.calls.some(([method]) => method === "POST")).toBe(false);
});
it("qa:TC missing SHO-2727: Unread and Load older retain generic non-linked notices and use the unread cursor", async () => {
  await mount(); await click("Unread · 2"); await click("Load older");
  expect(mocks.api.mock.calls.some(([, url]) => String(url).includes("before=cursor%7Cnewer&filter=unread"))).toBe(true);
  expect(document.querySelectorAll('.bell-main')).toHaveLength(2);
  expect(document.querySelector('a')).toBeNull();
  expect([...document.querySelectorAll('.bell-main')].every(el => el.textContent?.includes(generic))).toBe(true);
  expect(mocks.push).not.toHaveBeenCalled();
});
