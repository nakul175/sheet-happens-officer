/**
 * @vitest-environment jsdom
 */
// APL-2664 v1.1. One test per scenario (outline rows included). Pam's qa:TC markers from the issue are named on the cases they cover.
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
const SHARED_PROJECT = "Shared With Worker";
const PRIVATE_PROJECT = "Only P2 Project";
const NO_ACCESS = "You don't have access to this person";

let root: Root | undefined;
let restoreLocation: (() => void) | undefined;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function retryButton(page: HTMLElement) {
  return [...page.querySelectorAll("button")].find((b) => b.textContent === "Retry");
}

async function openPerson() {
  document.body.replaceChildren();
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
  document.title = "";
  window.history.pushState({}, "", "/team/p2");
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  restoreLocation?.();
  restoreLocation = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Person page shows a plain state for each failure", () => {
  it("A 403 shows a no-access message and no details qa:TC-APL2664-7beb43b5@v2", async () => {
    for (const code of ["FORBIDDEN", "NOT_ALLOWED"]) {
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe("/api/team/p2");
        return json(403, { error: "Forbidden", code });
      }));
      const page = await openPerson();
      expect(page.querySelector("[role=alert]")?.textContent, code).toBe(NO_ACCESS);
      expect(page.textContent, code).not.toContain("Could not load");
      expect(retryButton(page), code).toBeUndefined();
      act(() => root?.unmount());
    }
  });

  it("A 403 shows a no-access message and no details qa:TC-APL2664-61d8fa83@v2", async () => {
    const body = { error: "Forbidden", code: "FORBIDDEN" };
    vi.stubGlobal("fetch", vi.fn(async () => json(403, body)));
    const captured = JSON.stringify(body);
    const page = await openPerson();
    const html = page.innerHTML;
    for (const secret of ["ZZ-TEST-P2", "nakul17+zztest-p2", "ZZ-TEST-SHARED", "ZZ-TEST-PRIVATE", SECRET_NAME, SECRET_EMAIL, SECRET_PROJECT]) {
      expect(captured).not.toContain(secret);
      expect(html).not.toContain(secret);
      expect(document.title).not.toContain(secret);
    }
  });

  it("Other failures show plain messages: answers 401 qa:TC-APL2664-3d261d73@v1", async () => {
    // The visible session-expired sentence is deferred to APL-2652. This case only checks the existing redirect.
    const original = Object.getOwnPropertyDescriptor(window, "location");
    const location = { href: window.location.href };
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: location });
    restoreLocation = () => { if (original) Object.defineProperty(window, "location", original); };
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: `Session ended for ${SECRET_NAME}` })));
    const page = await openPerson();
    expect(location.href).toBe("/signin");
    expect(location.href).not.toContain("expired");
    expect(retryButton(page)).toBeUndefined();
    expect(page.textContent).not.toContain("Your session has expired");
    expect(page.textContent).not.toContain(NO_ACCESS);
    expect(page.innerHTML).not.toContain(SECRET_NAME);
  });

  it("Other failures show plain messages: answers 404 qa:TC-APL2664-a3ea3ce6@v1", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { error: "Person not found" })));
    const page = await openPerson();
    expect(page.querySelector("[role=alert]")?.textContent).toBe("Not found");
    expect(retryButton(page)).toBeUndefined();
    expect(page.textContent).not.toContain(NO_ACCESS);
    expect(page.textContent).not.toContain("Could not load");
    expect(page.innerHTML).not.toContain("ZZ-TEST-P3");
  });

  it("Other failures show plain messages: answers 500, 502 or 503 qa:TC-APL2664-e19c974c@v1", async () => {
    for (const status of [500, 502, 503]) {
      let calls = 0;
      vi.stubGlobal("fetch", vi.fn(async () => {
        calls += 1;
        if (calls === 1) return json(status, { error: `fault ${SECRET_NAME}` });
        return json(200, { person: { id: "p2", name: "P2 Visible Name", projects: [] } });
      }));
      const page = await openPerson();
      expect(page.textContent, String(status)).toContain("Something went wrong, try again");
      expect(retryButton(page)?.textContent, String(status)).toBe("Retry");
      expect(page.innerHTML, String(status)).not.toContain(SECRET_NAME);
      await act(async () => { retryButton(page)!.click(); });
      for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(page.textContent, String(status)).toContain("P2 Visible Name");
      expect(page.textContent, String(status)).not.toContain("Something went wrong, try again");
      act(() => root?.unmount());
    }
  });

  it("Other failures show plain messages: fails with a network error qa:TC-APL2664-c35d2187@v2", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const page = await openPerson();
    expect(page.textContent).toContain("Could not reach the server.");
    expect(retryButton(page)?.textContent).toBe("Retry");
    expect(page.textContent).not.toContain(NO_ACCESS);
    expect(page.textContent).not.toContain("Not found");
    expect(page.textContent).not.toContain("Your session has expired");
  });

  it("Allowed users see what their role allows: admin qa:TC-APL2664-e9ae6840@v2", async () => {
    harness.me = { id: "admin", name: "Admin", email: "admin@aplyd.com", orgRole: "ADMIN" };
    const joined = "2026-01-15T00:00:00.000Z";
    const joinedText = new Date(joined).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/team/p2");
      return json(200, {
        person: {
          id: "p2",
          name: "P2 Visible Name",
          email: "p2.visible@example.com",
          orgRole: "MEMBER",
          status: "ACTIVE",
          joinedAt: joined,
          openTasks: 2,
          projects: [
            { id: "proj-shared", name: SHARED_PROJECT, role: "EDITOR", openTasks: 1 },
            { id: "proj-private", name: PRIVATE_PROJECT, role: "LEADER", openTasks: 1 },
          ],
        },
      });
    }));

    const page = await openPerson();
    const text = page.textContent ?? "";
    expect(text).toContain("P2 Visible Name");
    expect(text).toContain("p2.visible@example.com");
    expect(text).toContain("Member");
    expect(text).toContain("Active");
    expect(text).toContain(joinedText);
    expect(text).toContain("2 open tasks");
    expect(text).toContain(SHARED_PROJECT);
    expect(text).toContain(PRIVATE_PROJECT);
    expect(text).not.toContain(NO_ACCESS);
    expect(text).not.toContain("Could not reach the server.");
  });

  it("Allowed users see what their role allows: worker qa:TC-APL2664-b7b130bf@v1", async () => {
    const body = {
      person: {
        id: "p2",
        name: "P2 Visible Name",
        projects: [{ id: "proj-shared", name: SHARED_PROJECT }],
      },
    };
    const captured = JSON.stringify(body);
    expect(captured).not.toContain("p2.visible@example.com");
    expect(captured).not.toContain(PRIVATE_PROJECT);
    expect(captured).not.toContain("orgRole");
    expect(captured).not.toContain("joinedAt");
    expect(captured).not.toContain("openTasks");
    vi.stubGlobal("fetch", vi.fn(async () => json(200, body)));

    const page = await openPerson();
    const text = page.textContent ?? "";
    expect(text).toContain("P2 Visible Name");
    expect(text).toContain(SHARED_PROJECT);
    expect(text).toContain("Projects you share");
    expect(text).not.toContain("p2.visible@example.com");
    expect(text).not.toContain(PRIVATE_PROJECT);
    expect(text).not.toContain("Active");
    expect(text).not.toContain("Joined");
    expect(text).not.toContain("open task");
    expect(text).not.toContain(NO_ACCESS);
  });

  // Mocked until PR #8 (APL-2624) merges. main does not answer 403 PASSWORD_CHANGE_REQUIRED for a signed-in person.
  it("A forced password change is not shown as no-access qa:TC-APL2664-0259816b@v1", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(403, {
      error: "Set your own password first.",
      code: "PASSWORD_CHANGE_REQUIRED",
      person: { id: "p2", name: SECRET_NAME, email: SECRET_EMAIL, projects: [{ id: "proj-secret", name: SECRET_PROJECT }] },
    })));

    const page = await openPerson();
    const text = page.textContent ?? "";
    expect(text).toContain("Set your own password");
    expect(text).toContain("The emailed one still works until you do.");
    expect(page.querySelector("a[href='/profile']")?.textContent).toBe("Change password");
    expect(text).not.toContain(NO_ACCESS);
    expect(page.innerHTML).not.toContain(SECRET_NAME);
    expect(page.innerHTML).not.toContain(SECRET_EMAIL);
    expect(page.innerHTML).not.toContain(SECRET_PROJECT);
    expect(document.title).not.toContain(SECRET_NAME);
  });
});
