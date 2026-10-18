// @vitest-environment jsdom
// APL-2665 v1: Audit, Members, Trash and New project use useGet's .failed flag.
// One test per acceptance criterion. Each case is tagged with its AC id.
import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import AuditView from "@/app/(app)/audit/AuditView";
import Members from "@/app/(app)/projects/[id]/members/Members";
import Trash from "@/app/(app)/projects/[id]/trash/Trash";
import NewProject from "@/app/(app)/projects/new/NewProject";

const FAILURE = "Could not reach the server";
const params = Promise.resolve({ id: "p1" });

const harness = vi.hoisted(() => ({
  me: { id: "me", name: "Ada Admin", email: "ada@aplyd.com", orgRole: "SUPER_ADMIN" as const },
}));

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) =>
      React.createElement("a", { href, className }, children),
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "p1" }),
  usePathname: () => "/projects/p1",
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

vi.mock("@/app/(app)/Shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/(app)/Shell")>();
  return { ...actual, useMe: () => harness.me };
});

const VIEWS = [
  { name: "Audit", ready: "SIGN_IN", render: () => <AuditView /> },
  { name: "Members", ready: "ZZ-TEST Member", render: () => <Members params={params} /> },
  { name: "Trash", ready: "ZZ-TEST deleted task", render: () => <Trash params={params} /> },
  { name: "New project", ready: "ZZ-TEST Colleague", render: () => <NewProject /> },
] as const;

const FILES = [
  "src/app/(app)/audit/AuditView.tsx",
  "src/app/(app)/projects/[id]/members/Members.tsx",
  "src/app/(app)/projects/[id]/trash/Trash.tsx",
  "src/app/(app)/projects/new/NewProject.tsx",
];

let root: Root | undefined;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function okBody(url: string) {
  if (url.startsWith("/api/audit")) {
    return {
      events: ["SIGN_IN"],
      items: [{ id: "e1", at: "2026-10-01T04:30:00.000Z", who: "Ada Admin", email: "ada@aplyd.com", event: "SIGN_IN", ip: "127.0.0.1", channel: "Screen", target: "ZZ-TEST-audit" }],
      nextCursor: null,
    };
  }
  if (url.startsWith("/api/jobs")) return { jobs: [] };
  if (url === "/api/team") {
    return {
      people: [
        { id: "me", name: "Ada Admin", email: "ada@aplyd.com", status: "ACTIVE" },
        { id: "u2", name: "ZZ-TEST Colleague", email: "c@aplyd.com", status: "ACTIVE" },
      ],
    };
  }
  if (url === "/api/projects/p1/trash") {
    return { items: [{ id: "t1", title: "ZZ-TEST deleted task", isSubtask: false, deletedAt: "2026-10-01T04:30:00.000Z", deletedBy: { name: "Ada Admin" }, daysLeft: 12 }] };
  }
  if (url === "/api/projects/p1") {
    return {
      project: {
        id: "p1", name: "ZZ-TEST Project", archived: false, role: "LEADER",
        members: [{ userId: "u2", name: "ZZ-TEST Member", role: "EDITOR", active: true, email: "m@aplyd.com" }],
      },
    };
  }
  throw new Error(`unexpected ${url}`);
}

type Mode = "pending" | "network" | "5xx" | "ok";

function installFetch(mode: Mode) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (mode === "pending") return new Promise<Response>(() => {});
    if (mode === "network") throw new TypeError("Failed to fetch");
    if (mode === "5xx") return json(503, { error: "down" });
    return json(200, okBody(url));
  }));
}

async function settle(ms = 0) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

async function show(node: ReactNode) {
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  return document.body;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("In-scope views use useGet's .failed flag", () => {
  // APL-2665 AC1 @v1 @kind-happy. One case for the scenario outline (Audit, Members, Trash, New project).
  it("A slow load is not shown as a failure", async () => {
    for (const view of VIEWS) {
      installFetch("pending");
      const page = await show(view.render());
      await settle(450);
      expect(page.querySelector(".skel-wrap"), `${view.name} loading state`).toBeTruthy();
      expect(page.textContent, view.name).not.toContain(FAILURE);
      expect(page.textContent, view.name).not.toContain(view.ready);
      act(() => root?.unmount());
      root = undefined;
    }
  });

  // APL-2665 AC2 @v1 @kind-error. Network error and HTTP 503, for each in-scope view.
  it("A real failure shows the error state", async () => {
    for (const mode of ["network", "5xx"] as const) {
      for (const view of VIEWS) {
        installFetch(mode);
        const page = await show(view.render());
        for (let i = 0; i < 20; i++) await settle();
        expect(page.textContent, `${view.name} ${mode}`).toContain("Could not reach the server.");
        expect([...page.querySelectorAll("button")].some((b) => b.textContent === "Retry"), `${view.name} ${mode}`).toBe(true);
        act(() => root?.unmount());
        root = undefined;
      }
    }
  });

  // APL-2665 AC3 @v1 @kind-regression. No isNetworkFailure(status) in the four files, and a successful load still renders.
  it("No old status check remains in scope", async () => {
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/isNetworkFailure\s*\(/);
      expect(src, file).toMatch(/\.failed/);
      expect(src, file).not.toMatch(/status\s*===\s*0|status\s*>=\s*500/);
    }
    for (const view of VIEWS) {
      installFetch("ok");
      const page = await show(view.render());
      for (let i = 0; i < 20 && !page.textContent?.includes(view.ready); i++) await settle();
      expect(page.textContent, view.name).toContain(view.ready);
      expect(page.textContent, view.name).not.toContain(FAILURE);
      act(() => root?.unmount());
      root = undefined;
    }
  });
});
