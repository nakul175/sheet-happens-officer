// @vitest-environment jsdom
// APL-2663 v1.1: useGet resets loading when the path changes.
// One test per Gherkin scenario. Pam's cases: six re-pinned to @v2, plus AC4 and AC5 at @v1.
import { mkdirSync, writeFileSync } from "node:fs";
import { createElement, useEffect, useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGet } from "@/components/api";
import { LoadFailed, Skeleton } from "@/components/ui";

type Data = { items: string[] };
type Snap = { loading: boolean; failed: boolean; error: string | null; code: string | null; data: Data | null; status: number };
type Pending = { url: string; resolve: (r: Response) => void; reject: (reason: unknown) => void };

const PATH_A = "/api/projects/ZZ-TEST-A";
const PATH_B = "/api/projects/ZZ-TEST-B";
const ITEMS_A = ["ZZ-TEST-A-item1", "ZZ-TEST-A-item2", "ZZ-TEST-A-item3"];
const ITEMS_B = ["ZZ-TEST-B-item1"];

let pending: Pending[] = [];
let calls: string[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let go: (path: string) => void = () => {};
let rerenderSame: () => void = () => {};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetch(opts?: { timed?: Record<string, { ms: number; body: unknown }> }) {
  calls = [];
  pending = [];
  const timed = opts?.timed ?? {};
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const job = timed[url];
    if (job) return new Promise<Response>((resolve) => { setTimeout(() => resolve(json(job.body)), job.ms); });
    return new Promise<Response>((resolve, reject) => { pending.push({ url, resolve, reject }); });
  });
}

function take(url: string): Pending {
  const i = pending.findIndex((p) => p.url === url);
  if (i < 0) throw new Error(`no pending ${url}; pending: ${pending.map((p) => p.url).join(", ") || "(none)"}`);
  return pending.splice(i, 1)[0]!;
}

function Probe({ path, log }: { path: string; log: Snap[] }) {
  const g = useGet<Data>(path);
  log.push({ loading: g.loading, failed: g.failed, error: g.error, code: g.code, data: g.data, status: g.status });
  const project = path === PATH_B ? "B" : "A";
  const items = g.data?.items ?? [];
  return createElement(
    "section",
    { "aria-label": `Project ${project}` },
    g.loading && !g.data ? createElement(Skeleton) : null,
    !g.data && g.failed ? createElement(LoadFailed, { onRetry: g.reload }) : null,
    !g.loading && g.error && !g.failed ? createElement("div", { className: "err", role: "alert" }, g.error) : null,
    createElement("ul", null, items.map((item) => createElement("li", { key: item }, item))),
  );
}

function Harness({ initial, log }: { initial: string; log: Snap[] }) {
  const [path, setPath] = useState(initial);
  const [, setN] = useState(0);
  useEffect(() => {
    go = setPath;
    rerenderSame = () => setN((n) => n + 1);
  }, [setPath]);
  return createElement(Probe, { path, log });
}

async function mount(initial = PATH_A) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const log: Snap[] = [];
  await act(async () => { root!.render(createElement(Harness, { initial, log })); });
  return { log };
}

async function settle(run: () => void) {
  await act(async () => { run(); });
}

const bodyText = () => document.body.textContent ?? "";
const section = () => document.querySelector("section");

/** Accessible bits of the content area, saved for qa:TC-APL2663-2437ecb8. */
function accessSnapshot(root: Element): string {
  const lines: string[] = [];
  const walk = (el: Element, depth: number) => {
    const role = el.getAttribute("role");
    const label = el.getAttribute("aria-label");
    const live = el.getAttribute("aria-live");
    const busy = el.getAttribute("aria-busy");
    const sr = el.classList.contains("sr-only");
    if (role || label || live || busy || sr) {
      const name = sr ? el.textContent?.trim() : label;
      const bits = [
        role ? `role=${role}` : "",
        live ? `aria-live=${live}` : "",
        busy ? `aria-busy=${busy}` : "",
        name ? `name=${JSON.stringify(name)}` : "",
      ].filter(Boolean);
      lines.push(`${"  ".repeat(depth)}${el.tagName.toLowerCase()} ${bits.join(" ")}`.trimEnd());
    }
    [...el.children].forEach((child) => walk(child, depth + 1));
  };
  walk(root, 0);
  return `${lines.join("\n")}\n`;
}
const hasAItem = (data: Data | null | undefined) => JSON.stringify(data ?? {}).includes("ZZ-TEST-A-item");

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = "";
  installFetch();
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
  pending = [];
});

describe("useGet resets its loading state when the path changes", () => {
  // qa:TC-APL2663-dd110f93@v2 — path change A to B shows loading, never A's data
  // qa:TC-APL2663-4941e080@v2 — B's view shows the loading state for the whole 2 s delay
  it("Navigating from project A to project B shows loading, not A's data", async () => {
    installFetch({ timed: { [PATH_B]: { ms: 2000, body: { items: ITEMS_B } } } });
    const { log } = await mount(PATH_A);
    await settle(() => { take(PATH_A).resolve(json({ items: ITEMS_A })); });
    expect(bodyText()).toContain("ZZ-TEST-A-item1");
    expect(bodyText()).toContain("ZZ-TEST-A-item3");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

    const mark = log.length;
    await act(async () => { go(PATH_B); });
    const same = log[mark];
    expect(same, "the render that receives B").toMatchObject({ loading: true, failed: false, error: null, data: null });
    expect(section()?.getAttribute("aria-label")).toBe("Project B");
    expect(bodyText()).not.toContain("ZZ-TEST-A-item");
    for (const snap of log.slice(mark)) expect(hasAItem(snap.data), "A items in a B render").toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(log.at(-1)).toMatchObject({ loading: true, failed: false, data: null });
    expect(bodyText()).not.toContain("ZZ-TEST-A-item");
    expect(section()?.querySelector("[role='status']")).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(log.at(-1)).toMatchObject({ loading: false, failed: false, error: null, data: { items: ITEMS_B } });
    expect(bodyText()).toContain("ZZ-TEST-B-item1");
    expect(bodyText()).not.toContain("ZZ-TEST-A-item");
    expect(section()?.querySelector("[role='status']")).toBeNull();
  });

  // qa:TC-APL2663-1af30363@v2 — error on the old path is cleared (network and HTTP 500)
  // qa:TC-APL2663-dfa02140@v2 — B failing shows B's own error only after B answers
  it("The error state belongs to the current path only", async () => {
    async function failA(how: "network" | "500" | "refused") {
      const { log } = await mount(PATH_A);
      await settle(() => {
        const a = take(PATH_A);
        if (how === "network") a.reject(new TypeError("Failed to fetch"));
        else if (how === "500") a.resolve(json({ error: "down" }, 500));
        else a.resolve(json({ error: "Project A is closed for edits" }, 400));
      });
      if (how === "refused") {
        expect(log.at(-1)?.failed, "a 400 is not a network failure").toBe(false);
        expect(log.at(-1)?.error).toBe("Project A is closed for edits");
        expect(document.querySelector("[role='alert']")?.textContent).toBe("Project A is closed for edits");
      } else {
        expect(log.at(-1)?.failed, `${how} on A`).toBe(true);
        expect(document.querySelector("[role='alert']")?.textContent).toContain("Could not reach the server.");
      }

      const mark = log.length;
      await act(async () => { go(PATH_B); });
      expect(log[mark]).toMatchObject({ loading: true, failed: false, error: null, data: null });
      expect(document.querySelector("[role='alert']")).toBeNull();
      expect(section()?.querySelector("[role='status']")).toBeTruthy();
      return { log };
    }

    const ok = await failA("network");
    await settle(() => { take(PATH_B).resolve(json({ items: ITEMS_B })); });
    expect(ok.log.at(-1)).toMatchObject({ loading: false, failed: false, error: null, data: { items: ITEMS_B } });
    expect(bodyText()).toContain("ZZ-TEST-B-item1");
    expect(document.querySelector("[role='alert']")).toBeNull();
    await act(async () => { root!.unmount(); });
    root = null;
    host?.remove();

    // qa:TC-APL2663-1af30363@v2 — HTTP 500 on A, then B's 200, in one pass.
    const server = await failA("500");
    await settle(() => { take(PATH_B).resolve(json({ items: ITEMS_B })); });
    expect(server.log.at(-1)).toMatchObject({ loading: false, failed: false, error: null, data: { items: ITEMS_B } });
    expect(bodyText()).toContain("ZZ-TEST-B-item1");
    expect(document.querySelector("[role='alert']")).toBeNull();
    expect(bodyText()).not.toContain("Could not reach the server.");
    await act(async () => { root!.unmount(); });
    root = null;
    host?.remove();

    // qa:TC-APL2663-dfa02140@v2 — A's error and B's error are different strings.
    const bad = await failA("refused");
    expect(document.querySelector("[role='alert']")).toBeNull();
    await settle(() => { take(PATH_B).resolve(json({ error: "Project B is closed for edits" }, 403)); });
    expect(bad.log.at(-1)?.failed).toBe(false);
    expect(bad.log.at(-1)?.loading).toBe(false);
    expect(bad.log.at(-1)?.data).toBeNull();
    expect(bad.log.at(-1)?.error).toBe("Project B is closed for edits");
    expect(bad.log.at(-1)?.error).not.toBe("Project A is closed for edits");
    expect(document.querySelector("[role='alert']")?.textContent).toBe("Project B is closed for edits");
    expect(bodyText()).not.toContain("Project A is closed for edits");
    expect(bodyText()).not.toContain("ZZ-TEST-A-item");
    // The alert is B's: it was absent for the whole time B was pending.
    const pendingSnaps = bad.log.slice(bad.log.findIndex((s) => s.loading && s.error === null && s.data === null));
    expect(pendingSnaps.some((s) => s.loading && s.failed)).toBe(false);

    // A 403 code (PASSWORD_CHANGE_REQUIRED) belongs to the path that failed, same as any other error.
    await act(async () => { root!.unmount(); });
    root = null;
    host?.remove();
    const coded = await mount(PATH_A);
    await settle(() => { take(PATH_A).resolve(json({ error: "Set your own password", code: "PASSWORD_CHANGE_REQUIRED" }, 403)); });
    expect(coded.log.at(-1)).toMatchObject({ status: 403, code: "PASSWORD_CHANGE_REQUIRED", failed: false });
    const codedMark = coded.log.length;
    await act(async () => { go(PATH_B); });
    expect(coded.log[codedMark]).toMatchObject({ loading: true, failed: false, error: null, code: null, data: null });
    await settle(() => { take(PATH_B).resolve(json({ items: ITEMS_B })); });
    expect(coded.log.at(-1)).toMatchObject({ loading: false, code: null, data: { items: ITEMS_B } });
  });

  // qa:TC-APL2663-55057f60@v2 — late success or failure for the old path is ignored
  // qa:TC-APL2663-e1d9e302@v2 — A → B → A shows only the latest request
  it("Only the latest request for the current path is shown", async () => {
    const first = await mount(PATH_A);
    await act(async () => { go(PATH_B); });
    expect(first.log.at(-1)).toMatchObject({ loading: true, data: null, error: null });
    const a1 = take(PATH_A);
    const b = take(PATH_B);
    await settle(() => { b.resolve(json({ items: ITEMS_B })); });
    expect(first.log.at(-1)?.data?.items).toEqual(ITEMS_B);
    await settle(() => { a1.resolve(json({ items: ITEMS_A })); });
    expect(first.log.at(-1)).toMatchObject({ loading: false, failed: false, data: { items: ITEMS_B } });
    expect(bodyText()).toContain("ZZ-TEST-B-item1");
    expect(bodyText()).not.toContain("ZZ-TEST-A-item");

    await act(async () => { root!.unmount(); });
    root = null;
    host?.remove();
    document.body.innerHTML = "";

    const lateFail = await mount(PATH_A);
    await act(async () => { go(PATH_B); });
    const aFail = take(PATH_A);
    const bOk = take(PATH_B);
    await settle(() => { bOk.resolve(json({ items: ITEMS_B })); });
    await settle(() => { aFail.reject(new TypeError("Failed to fetch")); });
    expect(lateFail.log.at(-1)).toMatchObject({ loading: false, failed: false, data: { items: ITEMS_B } });
    expect(document.querySelector("[role='alert']")).toBeNull();

    await act(async () => { root!.unmount(); });
    root = null;
    host?.remove();
    document.body.innerHTML = "";

    // A1 pending, then B, then A2. The fresh A2 result is shown before the late answers.
    async function backToA(rejectStaleA: boolean) {
      const round = await mount(PATH_A);
      await act(async () => { go(PATH_B); });
      await act(async () => { go(PATH_A); });
      expect(round.log.at(-1)).toMatchObject({ loading: true, failed: false, data: null, error: null });
      expect(bodyText()).not.toContain("ZZ-TEST-B-item");
      const a1 = take(PATH_A);
      const lateB = take(PATH_B);
      const a2 = take(PATH_A);
      await settle(() => { a2.resolve(json({ items: ["ZZ-TEST-A-fresh"] })); });
      expect(round.log.at(-1)).toMatchObject({ loading: false, failed: false, error: null, data: { items: ["ZZ-TEST-A-fresh"] } });
      expect(bodyText()).toContain("ZZ-TEST-A-fresh");
      expect(document.querySelector("[role='alert']")).toBeNull();
      await settle(() => { lateB.resolve(json({ items: ITEMS_B })); });
      if (rejectStaleA) await settle(() => { a1.reject(new TypeError("Failed to fetch")); });
      else await settle(() => { a1.resolve(json({ items: ["ZZ-TEST-A-old"] })); });
      expect(round.log.at(-1)).toMatchObject({ loading: false, failed: false, error: null, data: { items: ["ZZ-TEST-A-fresh"] } });
      expect(bodyText()).toContain("ZZ-TEST-A-fresh");
      expect(bodyText()).not.toContain("ZZ-TEST-B-item");
      expect(bodyText()).not.toContain("ZZ-TEST-A-old");
      expect(document.querySelector("[role='alert']")).toBeNull();
      expect(section()?.getAttribute("aria-label")).toBe("Project A");
      await act(async () => { root!.unmount(); });
      root = null;
      host?.remove();
      document.body.innerHTML = "";
    }
    await backToA(false);
    await backToA(true);
  });

  // qa:TC-APL2663-2437ecb8@v1 — skeleton is aria-busy and a polite live region announces Loading; focus stays
  it("Loading state is a busy skeleton announced politely", async () => {
    const keep = document.createElement("button");
    keep.type = "button";
    keep.textContent = "Stay";
    document.body.appendChild(keep);
    keep.focus();

    await mount(PATH_A);
    await settle(() => { take(PATH_A).resolve(json({ items: ITEMS_A })); });
    expect(document.activeElement).toBe(keep);

    await act(async () => { go(PATH_B); });
    const content = section();
    expect(content?.getAttribute("aria-label")).toBe("Project B");
    const skeleton = content?.querySelector<HTMLElement>(".skel-wrap");
    expect(skeleton, "skeleton in the B content area").toBeTruthy();
    expect(content?.contains(skeleton!)).toBe(true);
    // What a screen reader gets while B is loading.
    expect({
      role: skeleton?.getAttribute("role"),
      live: skeleton?.getAttribute("aria-live"),
      busy: skeleton?.getAttribute("aria-busy"),
      announced: skeleton?.querySelector(".sr-only")?.textContent,
    }).toEqual({ role: "status", live: "polite", busy: "true", announced: "Loading" });
    expect(skeleton?.textContent).toContain("Loading");
    const snapshot = accessSnapshot(content!);
    mkdirSync("test-results/useGet-path-reset", { recursive: true });
    // W240: this jsdom unit test used to write into test-results/a11y, the folder the browser tier's
    // a11y suite (tests/viewport/a11y.test.ts) owns for screenshots. Nothing reads this file and the
    // assertion below is on the `snapshot` variable, so it is evidence only — but evidence belongs in
    // a folder named after the test file, not in another suite's.
    writeFileSync("test-results/useGet-path-reset/TC-APL2663-2437ecb8.txt", snapshot);
    expect(snapshot).toBe([
      'section name="Project B"',
      '  div role=status aria-live=polite aria-busy=true',
      '    span name="Loading"',
      "",
    ].join("\n"));
    const focusWhileLoading = document.activeElement;
    expect(focusWhileLoading).toBe(keep);

    await settle(() => { take(PATH_B).resolve(json({ items: ITEMS_B })); });
    expect(content?.querySelector("[aria-busy]"), "aria-busy removed from the content area").toBeNull();
    expect(content?.querySelector(".skel-wrap")).toBeNull();
    expect(content?.querySelector("[role='status']")).toBeNull();
    expect(bodyText()).toContain("ZZ-TEST-B-item1");
    expect(document.activeElement, "focus is not moved when B loads").toBe(focusWhileLoading);
  });

  // qa:TC-APL2663-e272862d@v1 — same-path re-render does not reset, refetch, or flash a skeleton
  it("Re-rendering on the same path does not reset", async () => {
    const { log } = await mount(PATH_B);
    await settle(() => { take(PATH_B).resolve(json({ items: ITEMS_B })); });
    expect(log.at(-1)).toMatchObject({ loading: false, failed: false, error: null, data: { items: ITEMS_B } });
    const sent = calls.slice();
    const mark = log.length;
    const content = section()!;
    const flickers: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && (record.attributeName === "aria-busy" || record.attributeName === "role")) flickers.push(record.attributeName ?? "attribute");
        record.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.matches(".skel-wrap, [role='status'], [aria-busy='true']") || node.querySelector(".skel-wrap, [role='status'], [aria-busy='true']")) flickers.push(node.className || node.tagName);
        });
      }
    });
    watch.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy", "role"] });

    await act(async () => { rerenderSame(); });
    watch.disconnect();

    const paints = log.slice(mark);
    expect(paints.length, "the parent re-rendered").toBeGreaterThan(0);
    expect(paints.every((s) => s.loading === false && s.failed === false && s.error === null && JSON.stringify(s.data?.items) === JSON.stringify(ITEMS_B))).toBe(true);
    expect(calls, "no new request").toEqual(sent);
    expect(flickers, "no skeleton flicker").toEqual([]);
    expect(content.querySelector(".skel-wrap, [role='status'], [aria-busy]")).toBeNull();
    expect(bodyText()).toContain("ZZ-TEST-B-item1");
    expect(bodyText()).not.toContain("Loading");
  });
});
