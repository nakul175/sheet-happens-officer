// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: harness.push }) }));
vi.mock("@/components/api", () => ({ api: harness.api, ago: () => "just now" }));
import { Bell } from "@/app/(app)/Bell";

let root: Root;
let host: HTMLDivElement;
const text = "A deal you can't view was updated.";
const note = (id: string, href: string | null, read = false) => ({ id, text: href ? "An ordinary task" : text, href, read, createdAt: "2026-10-30T10:00:00Z" });
let read = false;

async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent) === label);
  expect(button, label).toBeTruthy();
  await act(async () => { button!.click(); });
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  read = false;
  harness.api.mockImplementation(async (method: string, url: string) => {
    if (method === "POST") { read = url.endsWith("/read"); return { ok: true }; }
    const older = url.includes("before=");
    const unread = url.includes("filter=unread");
    return { ok: true, data: { unread: read ? 1 : 2, items: older ? [note("older", null)] : [
      ...(!unread || !read ? [note("hidden", null, read)] : []), note("plain", "/tasks/plain"),
    ], next: older ? null : "cursor|hidden" } };
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<Bell />); });
  await click("Notifications, 2 unread");
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("renders a null-href notice as text, never a link, while keeping ordinary task navigation", async () => {
  expect(host.querySelectorAll('a[href="/tasks/plain"]')).toHaveLength(1);
  expect([...host.querySelectorAll("a")].some((a) => a.textContent?.includes(text))).toBe(false);
  const body = [...host.querySelectorAll("div")].find((el) => el.textContent === `${text}just now`);
  expect(body).toBeTruthy();
  await act(async () => { body!.click(); });
  expect(harness.push).not.toHaveBeenCalled();
  expect(harness.api.mock.calls.filter(([method]) => method === "POST")).toHaveLength(0);
});

it("loads older redacted text and preserves the unread query and explicit mark-read control", async () => {
  await click("Unread · 2");
  await click("Load older");
  expect(harness.api).toHaveBeenCalledWith("GET", "/api/notifications?limit=50&before=cursor%7Chidden&filter=unread");
  expect(host.textContent?.split(text)).toHaveLength(3);
  expect([...host.querySelectorAll("a")].some((a) => a.textContent?.includes(text))).toBe(false);
  await click(`Mark as read: ${text}`);
  expect(harness.api).toHaveBeenCalledWith("POST", "/api/notifications/hidden/read", {});
  expect(harness.api).toHaveBeenLastCalledWith("GET", "/api/notifications?limit=50&filter=unread");
  expect(host.textContent).not.toContain(text);
  expect(harness.push).not.toHaveBeenCalled();
});
