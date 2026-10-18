// @vitest-environment jsdom
// APL-2665 v1. One test per Pam TC. The old failure decision was isNetworkFailure(status)
// (status === 0 || status >= 500), which treats an in-flight status of 0 as a failure.
// These views decide from useGet's .failed instead.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import AuditView from "@/app/(app)/audit/AuditView";
import Members from "@/app/(app)/projects/[id]/members/Members";
import Trash from "@/app/(app)/projects/[id]/trash/Trash";
import NewProject from "@/app/(app)/projects/new/NewProject";

const FAILURE = "Could not reach the server";
const PROJECT_ID = "zz-test-project-2665";
const params = Promise.resolve({ id: PROJECT_ID });

const harness = vi.hoisted(() => ({
  me: { id: "me", name: "QA Admin", email: "nakul17+qa-admin@gmail.com", orgRole: "SUPER_ADMIN" as const },
}));

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) =>
      React.createElement("a", { href, className }, children),
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: PROJECT_ID }),
  usePathname: () => `/projects/${PROJECT_ID}`,
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

vi.mock("@/app/(app)/Shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/(app)/Shell")>();
  return { ...actual, useMe: () => harness.me };
});

const VIEWS = [
  { name: "Audit", ready: "ZZ-TEST-audit-row", empty: "No events match.", render: () => <AuditView /> },
  { name: "Members", ready: "ZZ-TEST-member", empty: "ZZ-TEST-project-2665", render: () => <Members params={params} /> },
  { name: "Trash", ready: "ZZ-TEST-trashed-task", empty: "Trash is empty.", render: () => <Trash params={params} /> },
  { name: "New project", ready: "ZZ-TEST-colleague", empty: "No one else is available to add yet.", render: () => <NewProject /> },
] as const;

const FILES = [
  "src/app/(app)/audit/AuditView.tsx",
  "src/app/(app)/projects/[id]/members/Members.tsx",
  "src/app/(app)/projects/[id]/trash/Trash.tsx",
  "src/app/(app)/projects/new/NewProject.tsx",
];

const LOADED_MARKERS = ["ZZ-TEST-audit-row", "ZZ-TEST-member", "ZZ-TEST-trashed-task", "ZZ-TEST-colleague"];
const EMPTY_AS_LOADED = ["No events match.", "Trash is empty.", "No one else is available to add yet."];

let root: Root | undefined;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function okBody(url: string, empty: boolean) {
  if (url.startsWith("/api/audit")) {
    return empty
      ? { events: [], items: [], nextCursor: null }
      : {
          events: ["SIGN_IN"],
          items: [{ id: "e1", at: "2026-10-01T04:30:00.000Z", who: "QA Admin", email: "nakul17+qa-admin@gmail.com", event: "SIGN_IN", ip: "127.0.0.1", channel: "Screen", target: "ZZ-TEST-audit-row" }],
          nextCursor: null,
        };
  }
  if (url.startsWith("/api/jobs")) return { jobs: [] };
  if (url === "/api/team") {
    return {
      people: empty
        ? []
        : [
            { id: "me", name: "QA Admin", email: "nakul17+qa-admin@gmail.com", status: "ACTIVE" },
            { id: "u2", name: "ZZ-TEST-colleague", email: "nakul17+qa-member@gmail.com", status: "ACTIVE" },
          ],
    };
  }
  if (url === `/api/projects/${PROJECT_ID}/trash`) {
    return empty
      ? { items: [] }
      : { items: [{ id: "t1", title: "ZZ-TEST-trashed-task", isSubtask: false, deletedAt: "2026-10-01T04:30:00.000Z", deletedBy: { name: "QA Admin" }, daysLeft: 12 }] };
  }
  if (url === `/api/projects/${PROJECT_ID}`) {
    return {
      project: {
        id: PROJECT_ID, name: "ZZ-TEST-project-2665", archived: false, role: "LEADER",
        members: empty ? [] : [{ userId: "u2", name: "ZZ-TEST-member", role: "EDITOR", active: true, email: "nakul17+qa-member@gmail.com" }],
      },
    };
  }
  throw new Error(`unexpected ${url}`);
}

type Held = { url: string; resolve: (r: Response) => void };

function installFetch(respond: (url: string) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => respond(String(input))));
}

function installHeld() {
  const pending: Held[] = [];
  installFetch((url) => new Promise<Response>((resolve) => pending.push({ url, resolve })));
  return pending;
}

function release(pending: Held[], status: number, empty = false) {
  for (const call of pending.splice(0)) call.resolve(json(status, status >= 200 && status < 300 ? okBody(call.url, empty) : { error: "down" }));
}

async function flush() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

async function show(node: ReactNode) {
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  return document.body;
}

function unmount() {
  act(() => root?.unmount());
  root = undefined;
}

afterEach(() => {
  unmount();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("In-scope views use useGet's .failed flag", () => {
  // qa:TC-APL2665-b7c814f3@v1 · AC1. Pending requests show loading in Audit, Members, Trash and New project.
  it("qa:TC-APL2665-b7c814f3@v1 slow load is not shown as a failure", async () => {
    for (const view of VIEWS) {
      installFetch(() => new Promise<Response>(() => {}));
      const page = await show(view.render());
      await flush();
      expect(page.querySelector(".skel-wrap"), `${view.name} loading state`).toBeTruthy();
      expect(page.textContent, view.name).not.toContain(FAILURE);
      expect(page.textContent, view.name).not.toContain(view.ready);
      unmount();
    }
  });

  // qa:TC-APL2665-051481c9@v1 · AC1. A slow load that later succeeds never flashes the error.
  it("qa:TC-APL2665-051481c9@v1 slow load then success shows no error", async () => {
    for (const view of VIEWS) {
      let sawError = false;
      const observer = new MutationObserver(() => {
        if (document.body.textContent?.includes(FAILURE)) sawError = true;
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      const pending = installHeld();
      const page = await show(view.render());
      expect(pending.length, `${view.name} issued a request`).toBeGreaterThan(0);
      expect(page.querySelector(".skel-wrap"), `${view.name} loading state`).toBeTruthy();
      expect(page.textContent, view.name).not.toContain(FAILURE);
      expect(sawError, view.name).toBe(false);
      await act(async () => { release(pending, 200); });
      await flush();
      expect(page.textContent, view.name).toContain(view.ready);
      expect(page.textContent, view.name).not.toContain(FAILURE);
      expect(sawError, `${view.name} flashed the error`).toBe(false);
      observer.disconnect();
      unmount();
    }
  });

  // qa:TC-APL2665-b06cea3a@v1 · AC2. A network error shows the existing error message.
  it("qa:TC-APL2665-b06cea3a@v1 network error shows the error state", async () => {
    for (const view of VIEWS) {
      installFetch(() => Promise.reject(new TypeError("Failed to fetch")));
      const page = await show(view.render());
      await flush();
      expect(page.textContent, view.name).toContain("Could not reach the server.");
      expect(page.querySelector(".skel-wrap"), `${view.name} loading gone`).toBeNull();
      for (const marker of LOADED_MARKERS) expect(page.textContent, view.name).not.toContain(marker);
      for (const phrase of EMPTY_AS_LOADED) expect(page.textContent, view.name).not.toContain(phrase);
      unmount();
    }
  });

  // qa:TC-APL2665-2d7b3f7f@v1 · AC2. HTTP 500 and 503 show the existing error message.
  it("qa:TC-APL2665-2d7b3f7f@v1 5xx shows the error state", async () => {
    for (const status of [500, 503]) {
      for (const view of VIEWS) {
        installFetch((url) => Promise.resolve(json(status, okBody(url, false))));
        const page = await show(view.render());
        await flush();
        expect(page.textContent, `${view.name} ${status}`).toContain("Could not reach the server.");
        expect(page.querySelector(".skel-wrap"), `${view.name} ${status} loading gone`).toBeNull();
        unmount();
      }
    }
  });

  // qa:TC-APL2665-ae74af03@v1 · AC3. No old status check in the four files, and api.ts is untouched.
  it("qa:TC-APL2665-ae74af03@v1 no old status check left in the 4 files", () => {
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toMatch(/\.failed/);
      expect(src, `${file} still decides failure with isNetworkFailure(status)`).not.toMatch(/isNetworkFailure\s*\(/);
      expect(src, file).not.toMatch(/status\s*===\s*0|status\s*>=\s*500/);
    }
    let changed: string[] | null = null;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], { stdio: "ignore" });
      changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
    } catch {
      changed = null;
    }
    if (changed) {
      expect(changed, "src/components/api.ts stays with APL-2663").not.toContain("src/components/api.ts");
    }
  });

  // qa:TC-APL2665-ef4b5ec8@v1 · AC3. Loaded data and the normal empty state still render.
  it("qa:TC-APL2665-ef4b5ec8@v1 loaded data renders as before", async () => {
    for (const empty of [false, true]) {
      for (const view of VIEWS) {
        installFetch((url) => Promise.resolve(json(200, okBody(url, empty))));
        const page = await show(view.render());
        await flush();
        expect(page.textContent, `${view.name} ${empty ? "empty" : "loaded"}`).toContain(empty ? view.empty : view.ready);
        expect(page.textContent, view.name).not.toContain(FAILURE);
        expect(page.querySelector(".skel-wrap"), view.name).toBeNull();
        unmount();
      }
    }
  });
});
