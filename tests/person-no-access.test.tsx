/**
 * @vitest-environment jsdom
 */
// APL-2664: the person page shows a no-access state when GET /api/team/:id answers 403,
// keeps LoadFailed for a real network failure, and still shows the person to an Admin.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Person from "@/app/(app)/team/[id]/Person";

type Role = "MEMBER" | "ADMIN" | "SUPER_ADMIN";

const harness = vi.hoisted(() => ({
  me: { id: "worker", name: "Worker", email: "worker@aplyd.com", orgRole: "MEMBER" as Role },
}));

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) =>
      React.createElement("a", { href, className }, children),
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "p2" }),
  usePathname: () => "/team/p2",
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

vi.mock("@/app/(app)/Shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/(app)/Shell")>();
  return { ...actual, useMe: () => harness.me };
});

const SECRET_NAME = "P2 Secret Name";
const SECRET_EMAIL = "p2.secret@example.com";
const SECRET_PROJECT = "P2 Secret Project";
const VISIBLE_NAME = "P2 Visible Name";
const VISIBLE_EMAIL = "p2.visible@example.com";
const VISIBLE_PROJECT = "P2 Visible Project";
const NO_ACCESS = "You don't have access to this person";

let root: Root | undefined;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function openPerson() {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Person />);
  });
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return document.body;
}

beforeEach(() => {
  harness.me = { id: "worker", name: "Worker", email: "worker@aplyd.com", orgRole: "MEMBER" };
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Person page shows a no-access state on 403", () => {
  it("A user without access sees a no-access message", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/team/p2");
      return json(403, {
        error: `Forbidden for ${SECRET_NAME} <${SECRET_EMAIL}> on ${SECRET_PROJECT}`,
        person: {
          id: "p2",
          name: SECRET_NAME,
          email: SECRET_EMAIL,
          projects: [{ id: "proj-secret", name: SECRET_PROJECT }],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const page = await openPerson();
    const text = page.textContent ?? "";

    expect(text).toContain(NO_ACCESS);
    expect(page.querySelector("[role=alert]")?.textContent).toBe(NO_ACCESS);
    expect(text).not.toContain("Could not load");
    expect(text).not.toContain("Could not reach");
    expect(text).not.toMatch(/retry/i);
    expect(text).not.toContain(SECRET_NAME);
    expect(text).not.toContain(SECRET_EMAIL);
    expect(text).not.toContain(SECRET_PROJECT);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("A real network failure still shows LoadFailed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));

    const page = await openPerson();
    const text = page.textContent ?? "";

    expect(text).toContain("Could not reach the server.");
    expect(page.querySelector("button")?.textContent).toBe("Retry");
    expect(text).not.toContain(NO_ACCESS);
  });

  it("Allowed users still see the person", async () => {
    harness.me = { id: "admin", name: "Admin", email: "admin@aplyd.com", orgRole: "ADMIN" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/team/p2");
      return json(200, {
        person: {
          id: "p2",
          name: VISIBLE_NAME,
          email: VISIBLE_EMAIL,
          orgRole: "MEMBER",
          status: "ACTIVE",
          joinedAt: "2026-01-15T00:00:00.000Z",
          openTasks: 2,
          projects: [{ id: "proj-1", name: VISIBLE_PROJECT, role: "EDITOR", openTasks: 2 }],
        },
      });
    }));

    const page = await openPerson();
    const text = page.textContent ?? "";

    expect(text).toContain(VISIBLE_NAME);
    expect(text).toContain(VISIBLE_EMAIL);
    expect(text).toContain(VISIBLE_PROJECT);
    expect(text).not.toContain(NO_ACCESS);
    expect(text).not.toContain("Could not reach the server.");
  });
});
