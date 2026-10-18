// @vitest-environment jsdom
// Search keeps the last results while the next query loads. The audit event dropdown keeps its options.
import { createElement, useEffect, useState, type ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGet } from "@/components/api";
import AuditView from "@/app/(app)/audit/AuditView";
import SearchView from "@/app/(app)/search/SearchView";

vi.mock("@/app/(app)/Shell", () => {
  const { createElement: h } = require("react") as typeof import("react");
  return {
    useMe: () => ({ id: "u1", name: "Nakul", email: "nakul17+zztest-admin@aplyd.com", orgRole: "SUPER_ADMIN", crm: false }),
    Page: ({ title, children }: { title?: unknown; children?: unknown }) => h("main", null, title ? h("h1", null, title) : null, children),
  };
});

type Pending = { url: string; resolve: (r: Response) => void };

let pending: Pending[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetch() {
  pending = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    return new Promise<Response>((resolve) => { pending.push({ url, resolve }); });
  });
}

function take(url: string): Pending {
  const i = pending.findIndex((p) => p.url === url);
  if (i < 0) throw new Error(`no pending ${url}; pending: ${pending.map((p) => p.url).join(", ") || "(none)"}`);
  return pending.splice(i, 1)[0]!;
}

async function render(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
}

async function settle(run: () => void) {
  await act(async () => { run(); });
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = "";
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    })) as typeof window.matchMedia;
  }
  installFetch();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
  pending = [];
});

function Rows({ path, keep }: { path: string | null; keep: boolean }) {
  const g = useGet<{ items: string[] }>(path, { keepPrevious: keep });
  return createElement("ul", { "data-loading": String(g.loading) }, (g.data?.items ?? []).map((item) => createElement("li", { key: item }, item)));
}

function Switcher({ keep }: { keep: boolean }) {
  const [path, setPath] = useState<string | null>("/api/search?q=alpha");
  useEffect(() => { (globalThis as { go?: (p: string | null) => void }).go = setPath; }, []);
  return createElement(Rows, { path, keep });
}

describe("stale-while-loading is opt-in", () => {
  it("a new path clears the previous page unless keepPrevious is set", async () => {
    await render(createElement(Switcher, { keep: false }));
    await settle(() => { take("/api/search?q=alpha").resolve(json({ items: ["ZZ-TEST-A-result"] })); });
    expect(document.body.textContent).toContain("ZZ-TEST-A-result");
    await act(async () => { (globalThis as { go: (p: string) => void }).go("/api/search?q=beta"); });
    expect(document.body.textContent).not.toContain("ZZ-TEST-A-result");
    expect(document.querySelector("ul")?.getAttribute("data-loading")).toBe("true");
    await act(async () => { root!.unmount(); });
    root = null;
    host?.remove();
    pending = [];

    await render(createElement(Switcher, { keep: true }));
    await settle(() => { take("/api/search?q=alpha").resolve(json({ items: ["ZZ-TEST-A-result"] })); });
    await act(async () => { (globalThis as { go: (p: string) => void }).go("/api/search?q=beta"); });
    expect(document.body.textContent, "previous results stay while the next query loads").toContain("ZZ-TEST-A-result");
    expect(document.querySelector("ul")?.getAttribute("data-loading")).toBe("true");
    await settle(() => { take("/api/search?q=beta").resolve(json({ items: ["ZZ-TEST-B-result"] })); });
    expect(document.body.textContent).toContain("ZZ-TEST-B-result");
    expect(document.body.textContent).not.toContain("ZZ-TEST-A-result");
  });

  it("Search keeps the previous results on screen while the new query loads", async () => {
    await render(createElement(SearchView));
    const input = document.querySelector("input[type=search]") as HTMLInputElement;
    await act(async () => { setValue(input, "alpha"); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    await settle(() => {
      take("/api/search?q=alpha").resolve(json({
        projects: [{ id: "p1", name: "ZZ-TEST-A-result", archived: false }],
        tasks: [],
      }));
    });
    expect(document.body.textContent).toContain("ZZ-TEST-A-result");

    await act(async () => { setValue(input, "beta"); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(pending.some((p) => p.url === "/api/search?q=beta"), "the new query is in flight").toBe(true);
    expect(document.body.textContent, "the list is not blanked").toContain("ZZ-TEST-A-result");
    expect(document.body.textContent).not.toContain("Type at least two letters.");

    await settle(() => {
      take("/api/search?q=beta").resolve(json({
        projects: [{ id: "p2", name: "ZZ-TEST-B-result", archived: false }],
        tasks: [],
      }));
    });
    expect(document.body.textContent).toContain("ZZ-TEST-B-result");
    expect(document.body.textContent).not.toContain("ZZ-TEST-A-result");
  });

  it("the audit event dropdown keeps its options while the next filter loads", async () => {
    await render(createElement(AuditView));
    const events = ["ACCOUNT_CREATED", "SIGN_IN"];
    await settle(() => {
      take("/api/team").resolve(json({ people: [] }));
      take("/api/audit").resolve(json({
        events,
        items: [{ id: "e1", at: "2026-01-02T04:30:00.000Z", who: "Nakul", email: null, event: "SIGN_IN", ip: null, channel: "Screen", target: null }],
        nextCursor: null,
      }));
      take("/api/jobs").resolve(json({ jobs: [] }));
    });
    const select = document.querySelector("select[aria-label='Event']") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["All events", "ACCOUNT_CREATED", "SIGN_IN"]);

    await act(async () => { setValue(select, "SIGN_IN"); });
    expect(pending.some((p) => p.url === "/api/audit?event=SIGN_IN")).toBe(true);
    expect(select.value, "the chosen event stays selected").toBe("SIGN_IN");
    expect([...select.options].map((o) => o.value), "options do not collapse to All events").toEqual(["", "ACCOUNT_CREATED", "SIGN_IN"]);

    await settle(() => {
      take("/api/audit?event=SIGN_IN").resolve(json({ events, items: [], nextCursor: null }));
    });
    expect([...select.options].map((o) => o.value)).toEqual(["", "ACCOUNT_CREATED", "SIGN_IN"]);
    expect(select.value).toBe("SIGN_IN");
  });
});
