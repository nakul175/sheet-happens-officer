// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HolySheetDocuments } from "../src/components/HolySheetDocuments";
const editor = vi.hoisted(() => ({ provider: null as null | { check: (args: { signal: AbortSignal }) => Promise<{ status: string; origin?: string }> } }));
vi.mock("@aplyd/holy-sheet-editor/hosted", () => ({ HolySheetEditor: ({ sessionProvider }: { sessionProvider: typeof editor.provider }) => { editor.provider = sessionProvider; return null; } }));
const context = { origin: "https://holysheet.aplyd.org", subject: "test-subject", canWrite: true, links: [], defaultSpaceId: "test-space" };
let root: Root | undefined;
let host: HTMLDivElement;
async function renderDocuments() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<HolySheetDocuments kind="projects" id="test-project" />); });
}
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); sessionStorage.clear(); editor.provider = null; vi.unstubAllGlobals(); });
it("refreshes the embedded editor session provider when the approved origin changes", async () => {
  const pageId = "11111111-1111-4111-8111-111111111111";
  let current = { ...context, links: [{ pageId }] };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(current), { status: 200 })));
  await renderDocuments();
  await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent === "Document 1")!.click(); });
  const first = editor.provider;
  expect(first).not.toBeNull();
  expect(await first!.check({ signal: new AbortController().signal })).toMatchObject({ status: "ready", origin: context.origin });

  current = { ...current, origin: "https://staging.holysheet.aplyd.org" };
  await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent === "Check access again")!.click(); });
  expect(host.textContent).not.toContain("Close document");
  await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent === "Document 1")!.click(); });
  expect(editor.provider).not.toBe(first);
  expect(await editor.provider!.check({ signal: new AbortController().signal })).toMatchObject({ status: "ready", origin: current.origin });
});
it("closes an old-origin picker and does not offer its pending link after an approved origin change", async () => {
  let current = { ...context };
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
    ? new Response(JSON.stringify({ error: "Temporary failure" }), { status: 503 })
    : new Response(JSON.stringify(current), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await renderDocuments();
  await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent === "Link existing page")!.click(); });
  const frame = host.querySelector<HTMLIFrameElement>('iframe[title="Choose Holy Sheet page"]')!;
  const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("hs-channel");
  await act(async () => { window.dispatchEvent(new MessageEvent("message", {
    origin: context.origin, source: frame.contentWindow,
    data: { type: "hs-document-selected", channel, subject: context.subject, pageId: "11111111-1111-4111-8111-111111111111", spaceId: "test-space", created: false },
  })); });
  expect(host.textContent).toContain("waiting to be linked");
  current = { ...current, origin: "https://staging.holysheet.aplyd.org" };
  await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent === "Check access again")!.click(); });
  expect(host.querySelector('iframe[title="Choose Holy Sheet page"]')).toBeNull();
  expect(host.textContent).not.toContain("waiting to be linked");
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
it.each(["create", "link"] as const)("opens the %s picker with the checked identity, origin and a fresh channel", async mode => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(context), { status: 200 })));
  await renderDocuments();
  const button = [...host.querySelectorAll("button")].find(b => b.textContent === (mode === "create" ? "Create page" : "Link existing page"));
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
  const frame = host.querySelector<HTMLIFrameElement>('iframe[title="Choose Holy Sheet page"]')!;
  expect(frame).not.toBeNull();
  const target = new URL(frame.src), hash = new URLSearchParams(target.hash.slice(1));
  expect(target.origin).toBe(context.origin);
  expect(target.pathname).toBe("/embed/picker");
  expect(hash.get("hs-user")).toBe(context.subject);
  expect(hash.get("hs-host")).toBe("https://sheethappensofficer.aplyd.org");
  expect(hash.get("hs-mode")).toBe(mode);
  expect(hash.get("hs-space")).toBe(context.defaultSpaceId);
  expect(hash.get("hs-channel")).toMatch(/^[0-9a-f-]{36}$/i);
});
it("keeps a checked read-only source from opening a mutation picker", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...context, canWrite: false }), { status: 200 })));
  await renderDocuments();
  const names = [...host.querySelectorAll("button")].map(b => b.textContent);
  expect(names).toContain("Check access again");
  expect(names).not.toContain("Create page");
  expect(names).not.toContain("Link existing page");
  expect(host.querySelector('iframe[title="Choose Holy Sheet page"]')).toBeNull();
});
it("rejects picker messages with the wrong origin, frame, channel, or subject", async () => {
  const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
    void args;
    return new Response(JSON.stringify(context), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderDocuments();
  const button = [...host.querySelectorAll("button")].find(b => b.textContent === "Link existing page")!;
  await act(async () => { button.click(); });
  const frame = host.querySelector<HTMLIFrameElement>('iframe[title="Choose Holy Sheet page"]')!;
  const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("hs-channel");
  const selected = { type: "hs-document-selected", channel, subject: context.subject, pageId: "11111111-1111-4111-8111-111111111111", spaceId: "test-space", created: false };
  const send = async (origin: string, source: MessageEventSource | null, data: object) => {
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin, source, data })); });
  };
  await send("https://attacker.example", frame.contentWindow, selected);
  await send(context.origin, window, selected);
  await send(context.origin, frame.contentWindow, { ...selected, channel: crypto.randomUUID() });
  await send(context.origin, frame.contentWindow, { ...selected, subject: "other-subject" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain("waiting to be linked");
  await send(context.origin, frame.contentWindow, selected);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
});
