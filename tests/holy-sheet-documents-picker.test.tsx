// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HolySheetDocuments } from "../src/components/HolySheetDocuments";
vi.mock("@aplyd/holy-sheet-editor/hosted", () => ({ HolySheetEditor: () => null }));
const context = { origin: "https://holysheet.aplyd.org", subject: "test-subject", canWrite: true, links: [], defaultSpaceId: "test-space" };
let root: Root | undefined;
let host: HTMLDivElement;
async function renderDocuments() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<HolySheetDocuments kind="projects" id="test-project" />); });
}
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); sessionStorage.clear(); vi.unstubAllGlobals(); });
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
