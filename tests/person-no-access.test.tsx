/**
 * @vitest-environment jsdom
 */
// APL-2664 v1.2. One test per scenario. Pam's qa:TC markers are named on the cases they cover.
// TC-APL2664-3d261d73 is retired; the session-expired sentence moved to APL-2652.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Person from "@/app/(app)/team/[id]/Person";
import { account, BASE, Client, OUTBOX, project, PW, superAdmin } from "./helpers";

type Role = "MEMBER" | "ADMIN" | "SUPER_ADMIN";

const harness = vi.hoisted(() => ({
  me: { id: "worker", name: "Worker", email: "worker@aplyd.com", orgRole: "MEMBER" as Role },
  id: "p2",
}));

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) =>
      React.createElement("a", { href, className }, children),
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: harness.id }),
  usePathname: () => `/team/${harness.id}`,
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

vi.mock("@/app/(app)/Shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/(app)/Shell")>();
  return { ...actual, useMe: () => harness.me };
});

const P2_NAME = "ZZ-TEST-P2";
const P2_EMAIL = "nakul17+zztest-p2@aplyd.com";
const SHARED_PROJECT = "ZZ-TEST-SHARED";
const PRIVATE_PROJECT = "ZZ-TEST-PRIVATE";
const NO_ACCESS = "You don't have access to this person";

let root: Root | undefined;

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
  harness.id = "p2";
  document.title = "";
  window.history.pushState({}, "", "/team/p2");
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Person page shows a plain state for each failure", () => {
  it("A 403 shows a no-access message and no details qa:TC-APL2664-7beb43b5@v3", async () => {
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

  it("A 403 shows a no-access message and no details qa:TC-APL2664-61d8fa83@v3", async () => {
    // The mock carries P2's real name, email and projects. The page must not render any of them.
    vi.stubGlobal("fetch", vi.fn(async () => json(403, {
      error: "Forbidden",
      code: "FORBIDDEN",
      person: {
        id: "p2",
        name: P2_NAME,
        email: P2_EMAIL,
        projects: [
          { id: "proj-shared", name: SHARED_PROJECT },
          { id: "proj-private", name: PRIVATE_PROJECT },
        ],
      },
    })));
    const page = await openPerson();
    const html = page.innerHTML;
    for (const secret of [P2_NAME, "nakul17+zztest-p2", SHARED_PROJECT, PRIVATE_PROJECT]) {
      expect(html).not.toContain(secret);
      expect(document.title).not.toContain(secret);
    }
    expect(page.textContent).toContain(NO_ACCESS);
  });

  it("A 401 defers to the global 401 rule qa:TC-APL2664-42d91db8@v1", async () => {
    // No Person-page message or Retry. The redirect itself is APL-2652, not this case.
    vi.stubGlobal("fetch", vi.fn(async () => json(401, {
      error: "Your session has expired, please sign in again",
      person: { id: "p2", name: P2_NAME, email: P2_EMAIL, projects: [{ id: "proj-shared", name: SHARED_PROJECT }] },
    })));
    const page = await openPerson();
    const text = page.textContent ?? "";
    expect(retryButton(page)).toBeUndefined();
    expect(page.querySelector("[role=alert]")).toBeNull();
    expect(text).not.toContain("Your session has expired");
    expect(text).not.toContain("Not found");
    expect(text).not.toContain("Something went wrong");
    expect(text).not.toContain("Could not reach the server");
    expect(text).not.toContain(NO_ACCESS);
    expect(text).not.toContain(P2_NAME);
  });

  it("Other failures show plain messages: answers 404 qa:TC-APL2664-a3ea3ce6@v2", async () => {
    // A real deactivated person, so a leak of their name can fail this case. Needs the app on TASKBOARD_URL.
    const worker = await account("worker");
    const sa = await superAdmin();
    const lead = await account("lead");
    // Signup stores the address in lower case, so the name ZZ-TEST-P3 cannot also be the mailbox.
    const email = `zz-test-p3-${Date.now()}@aplyd.com`;
    const signup = new Client();
    expect((await signup.post("/api/auth/signup", { name: "ZZ-TEST-P3", email, password: PW })).status).toBe(201);
    const verifyText = readdirSync(OUTBOX).sort().map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8"))).filter((m) => m.to === email && /Verify/.test(m.subject)).at(-1)?.text ?? "";
    expect((await signup.post("/api/auth/verify", { token: verifyText.match(/token=([\w-]+)/)?.[1] })).status).toBe(200);
    const signed = await signup.post("/api/auth/signin", { email, password: PW });
    expect(signed.status).toBe(200);
    const p3 = { c: signup, id: signed.json.user.id as string, email, name: "ZZ-TEST-P3" };
    const priv = await project(sa, lead, [{ who: p3 }]);
    const privateName = (await lead.c.get(`/api/projects/${priv.id}`)).json.project.name as string;
    expect((await sa.c.post(`/api/team/${p3.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    harness.me = { id: worker.id, name: worker.name, email: worker.email, orgRole: "MEMBER" };
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const headers = new Headers(init?.headers);
      if (worker.c.cookie) headers.set("cookie", worker.c.cookie);
      return realFetch(path.startsWith("http") ? path : BASE + path, { ...init, headers });
    });

    harness.id = `missing-${Date.now()}`;
    let page = await openPerson();
    expect(page.querySelector("[role=alert]")?.textContent).toBe("Not found");
    expect(retryButton(page)).toBeUndefined();
    expect(page.textContent).not.toContain(NO_ACCESS);

    act(() => root?.unmount());
    harness.id = p3.id;
    page = await openPerson();
    expect(page.querySelector("[role=alert]")?.textContent).toBe("Not found");
    expect(retryButton(page)).toBeUndefined();
    expect(page.textContent).not.toContain(NO_ACCESS);
    expect(page.textContent).not.toContain("Could not load");
    expect(page.innerHTML).not.toContain(p3.name);
    expect(page.innerHTML).not.toContain(p3.email);
    expect(page.innerHTML).not.toContain(privateName);
  });

  it("Other failures show plain messages: answers 500, 502 or 503 qa:TC-APL2664-e19c974c@v2", async () => {
    for (const status of [500, 502, 503]) {
      let calls = 0;
      vi.stubGlobal("fetch", vi.fn(async () => {
        calls += 1;
        if (calls === 1) return json(status, { error: `fault ${P2_NAME}`, person: { name: P2_NAME, email: P2_EMAIL } });
        return json(200, { person: { id: "p2", name: P2_NAME, projects: [] } });
      }));
      const page = await openPerson();
      expect(page.textContent, String(status)).toContain("Something went wrong, try again");
      expect(retryButton(page)?.textContent, String(status)).toBe("Retry");
      expect(page.innerHTML, String(status)).not.toContain(P2_NAME);
      await act(async () => { retryButton(page)!.click(); });
      for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(page.textContent, String(status)).toContain(P2_NAME);
      expect(page.textContent, String(status)).not.toContain("Something went wrong, try again");
      act(() => root?.unmount());
    }
  });

  it("Other failures show plain messages: fails with a network error qa:TC-APL2664-c35d2187@v3", async () => {
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

  it("Allowed users see what their role allows: admin qa:TC-APL2664-e9ae6840@v3", async () => {
    harness.me = { id: "admin", name: "Admin", email: "admin@aplyd.com", orgRole: "ADMIN" };
    const joined = "2026-01-15T00:00:00.000Z";
    const joinedText = new Date(joined).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/team/p2");
      return json(200, {
        person: {
          id: "p2",
          name: P2_NAME,
          email: P2_EMAIL,
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
    expect(text).toContain(P2_NAME);
    expect(text).toContain(P2_EMAIL);
    expect(text).toContain("Member");
    expect(text).toContain("Active");
    expect(text).toContain(joinedText);
    expect(text).toContain("2 open tasks");
    expect(text).toContain(SHARED_PROJECT);
    expect(text).toContain(PRIVATE_PROJECT);
    expect(text).not.toContain(NO_ACCESS);
    expect(text).not.toContain("Could not reach the server.");
  });

  it("Allowed users see what their role allows: worker qa:TC-APL2664-b7b130bf@v2", async () => {
    // The page is a member. Role data is in the payload so a shown role label fails this case.
    // The live response is checked in tests/people.test.ts, not by stringifying this fixture.
    vi.stubGlobal("fetch", vi.fn(async () => json(200, {
      person: {
        id: "p2",
        name: P2_NAME,
        email: P2_EMAIL,
        orgRole: "MEMBER",
        status: "ACTIVE",
        joinedAt: "2026-01-15T00:00:00.000Z",
        openTasks: 2,
        projects: [{ id: "proj-shared", name: SHARED_PROJECT, role: "EDITOR", openTasks: 1 }],
      },
    })));

    const page = await openPerson();
    const text = page.textContent ?? "";
    expect(text).toContain(P2_NAME);
    expect(text).toContain(SHARED_PROJECT);
    expect(text).toContain("Projects you share");
    expect(text).not.toContain(P2_EMAIL);
    expect(text).not.toContain("Member");
    expect(text).not.toContain("Admin");
    expect(text).not.toContain("Their role");
    expect(text).not.toContain("Active");
    expect(text).not.toContain("Joined");
    expect(text).not.toContain("open task");
    expect(text).not.toContain(PRIVATE_PROJECT);
    expect(text).not.toContain(NO_ACCESS);
  });

  // Mocked until PR #8 (APL-2624) merges. main does not answer 403 PASSWORD_CHANGE_REQUIRED for a signed-in person.
  it("A forced password change is not shown as no-access qa:TC-APL2664-0259816b@v2", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(403, {
      error: "Set your own password first.",
      code: "PASSWORD_CHANGE_REQUIRED",
      person: { id: "p2", name: P2_NAME, email: P2_EMAIL, projects: [{ id: "proj-private", name: PRIVATE_PROJECT }] },
    })));

    const page = await openPerson();
    const text = page.textContent ?? "";
    expect(text).toContain("Set your own password");
    expect(text).toContain("The emailed one still works until you do.");
    expect(page.querySelector("a[href='/profile']")?.textContent).toBe("Change password");
    expect(text).not.toContain(NO_ACCESS);
    expect(page.innerHTML).not.toContain(P2_NAME);
    expect(page.innerHTML).not.toContain(P2_EMAIL);
    expect(page.innerHTML).not.toContain(PRIVATE_PROJECT);
    expect(document.title).not.toContain(P2_NAME);
  });
});
