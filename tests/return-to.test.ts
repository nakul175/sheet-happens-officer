// APL-2652. Same-origin return path after sign-in, and the signed-out redirect that carries it.
// The cases at the top do not need a server. The "signed-out redirect" cases hit TASKBOARD_URL.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { api } from "@/components/api";
import { proxy } from "@/proxy";
import { account, BASE, project, task } from "./helpers";
import { isSignInScreen, returnToEnabled, safeReturnPath, sessionSignInTarget, signedOutSignInHref, signInHref } from "@/lib/return-to";

const BASE_ORIGIN = "http://return.invalid";

function expectSafe(path: string | null) {
  expect(path, "a safe path").toBeTruthy();
  expect(path!.startsWith("/"), path!).toBe(true);
  expect(path!.startsWith("//"), path!).toBe(false);
  expect(path).not.toMatch(/[\\\u0000-\u001F\u007F]/);
  expect(new URL(path!, BASE_ORIGIN).origin).toBe(BASE_ORIGIN);
}

describe("APL-2652 safe return path", () => {
  const previous = process.env.SIGNIN_RETURN_TO;
  beforeEach(() => {
    process.env.SIGNIN_RETURN_TO = "on";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.SIGNIN_RETURN_TO;
    else process.env.SIGNIN_RETURN_TO = previous;
  });

  it("keeps a same-origin deep link and drops the fragment", () => {
    expect(safeReturnPath("/tasks/T1")).toBe("/tasks/T1");
    expect(safeReturnPath("  /tasks/T1  ")).toBe("/tasks/T1");
    expect(safeReturnPath("/tasks/T1?x=1")).toBe("/tasks/T1?x=1");
    expect(safeReturnPath("/projects/abc?task=T1")).toBe("/projects/abc?task=T1");
    // AC1 v1.2: path and query stay; the #fragment is not part of next.
    expect(safeReturnPath("/projects/abc?task=T1#panel")).toBe("/projects/abc?task=T1");
    expect(safeReturnPath("/tasks/T1?tab=comments#c9")).toBe("/tasks/T1?tab=comments");
    expect(signInHref("/tasks/T1?tab=comments#c9")).toBe("/signin?next=%2Ftasks%2FT1%3Ftab%3Dcomments");
    expect(safeReturnPath("/")).toBe("/");
    expect(safeReturnPath("%2Ftasks%2FT1")).toBe("/tasks/T1");
    expect(safeReturnPath("%2Fprojects%2Fabc%3Ftask%3DT1")).toBe("/projects/abc?task=T1");
    expect(safeReturnPath("%2Ftasks%2FT1%3Ftab%3Dcomments%23c9")).toBe("/tasks/T1?tab=comments");
  });

  it("AC2 rejects absolute, protocol-relative, backslash and javascript targets", () => {
    for (const next of [
      "https://evil.example",
      "http://evil.example",
      "HTTPS://evil.example",
      "https://evil.example/tasks/T1",
      "//evil.example",
      "//evil.example/tasks",
      "///evil.example",
      "/\\evil.example",
      "/\\\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,hi",
      "mailto:a@evil.example",
    ]) {
      expect(safeReturnPath(next), next).toBeNull();
      expect(signInHref(next), next).toBe("/signin");
    }
  });

  it("rejects encoded tricks that decode to a protocol-relative URL, a backslash or a scheme", () => {
    for (const next of [
      "/%2f%2fevil.example",
      "/%2F%2Fevil.example",
      "/%252f%252fevil.example",
      "/%252F%252Fevil.example",
      "%2F%2Fevil.example",
      "%252F%252Fevil.example",
      "/%5Cevil.example",
      "/%5c%5cevil.example",
      "/%5C%5Cevil.example",
      "/%09/evil.example",
      "/%0a/evil.example",
      "/%0d%0aLocation:%20https://evil.example",
      "javascript%3Aalert(1)",
      "https%3A%2F%2Fevil.example",
      "https%3A%2F%2Fevil.example%2Ftasks",
      " \\evil.example",
      " https://evil.example",
      "\thttps://evil.example",
      "\n//evil.example",
      "//evil.example%00.localhost",
      "/\\@evil.example",
      "http://evil.example\\@localhost/tasks",
    ]) {
      expect(safeReturnPath(next), next).toBeNull();
      expect(signInHref(next), next).toBe("/signin");
    }
  });

  it("AC2 follows next only for a same-origin page path; anything else falls back to the home page", () => {
    expect(safeReturnPath("/tasks/T1")).toBe("/tasks/T1");
    expect(safeReturnPath("/projects/abc?tab=comments")).toBe("/projects/abc?tab=comments");
    const rejected = [
      "https://evil.example",
      "http://evil.example/tasks/T1",
      "HTTPS://evil.example",
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "javascript%3Aalert(1)",
      "https%3A%2F%2Fevil.example",
      "%2F%2Fevil.example",
      "/%2f%2fevil.example",
      "/%252f%252fevil.example",
      "/%5Cevil.example",
      "/%09/evil.example",
      "/api/tasks",
      "/api",
      "/api/tasks?x=1",
      "/%2Fapi%2Ftasks",
      "/%61pi/tasks",
      "/signin",
      "/signin?next=/tasks/T1",
    ];
    for (const next of rejected) {
      expect(safeReturnPath(next), next).toBeNull();
      expect(signInHref(next), next).toBe("/signin");
      expect(signedOutSignInHref(next), next).toBe("/signin");
    }
  });

  it("rejects encoded whitespace, and decodes a return path once", () => {
    for (const next of [
      "/tasks/a%20b",
      "/tasks/a%2520b",
      "%20/tasks/T1",
      "/tasks/T1%20",
      "/tasks/T1?tab=a%20b",
      "/%20/evil.example",
      "/tasks/a b",
      "/tasks/a\u00A0b",
    ]) {
      expect(safeReturnPath(next), next).toBeNull();
      expect(signInHref(next), next).toBe("/signin");
    }
    const encode = (value: string, times: number) => {
      let out = value;
      for (let i = 0; i < times; i++) out = encodeURIComponent(out);
      return out;
    };
    // Michael's ruling: one decode. Anything still encoded or unsafe after it falls back to the home page.
    expect(safeReturnPath(encode("/tasks/T1", 1))).toBe("/tasks/T1");
    expect(safeReturnPath(encode("/tasks/T1?tab=comments", 1))).toBe("/tasks/T1?tab=comments");
    expect(safeReturnPath(encode("/tasks/T1", 2))).toBeNull();
    expect(safeReturnPath(encode("/tasks/T1?tab=comments", 5))).toBeNull();
    expect(safeReturnPath(encode("//evil.example", 1))).toBeNull();
    expect(safeReturnPath(encode("https://evil.example", 1))).toBeNull();
    expect(safeReturnPath(encode("/\\evil.example", 1))).toBeNull();
    expect(safeReturnPath(encode("/tasks/a b", 1))).toBeNull();
  });

  it("qa:TC-APL2652-c26e8af9 decodes once, counting the router's decode", () => {
    const encode = (value: string, times: number) => {
      let out = value;
      for (let i = 0; i < times; i++) out = encodeURIComponent(out);
      return out;
    };
    // The router decodes the query once. That is the one decode, so a path still encoded after it falls back.
    expect(safeReturnPath(decodeURIComponent(encode("/tasks/T1?tab=comments", 1)), 1)).toBe("/tasks/T1?tab=comments");
    expect(safeReturnPath(decodeURIComponent(encode("/tasks/T1?tab=comments", 2)), 1)).toBeNull();
    expect(safeReturnPath(decodeURIComponent(encode("/tasks/T1?tab=comments", 6)), 1)).toBeNull();
    expect(safeReturnPath(decodeURIComponent(encode("//evil.example", 2)), 1)).toBeNull();
  });

  it("D1 keeps an encoded query value: R%26D, C%2B%2B and 100%25", () => {
    const cases: [string, string][] = [
      ["/tasks/T1?q=R%26D", "R&D"],
      ["/tasks/T1?q=C%2B%2B", "C++"],
      ["/tasks/T1?q=100%25", "100%"],
    ];
    for (const [path, q] of cases) {
      // The sign-in page: the router has already decoded `next` once.
      const fromRouter = safeReturnPath(new URL(`/signin?next=${encodeURIComponent(path)}`, BASE_ORIGIN).searchParams.get("next"), 1);
      expect(fromRouter, path).toBe(path);
      expect(new URL(fromRouter!, BASE_ORIGIN).searchParams.get("q"), path).toBe(q);
      // A raw `next` value that nothing has decoded yet.
      expect(safeReturnPath(encodeURIComponent(path)), path).toBe(path);
      // A 401 or a signed-out request builds next from the URL as it stands, and the sign-in page lands on the same URL.
      const href = signInHref(path);
      const landed = safeReturnPath(new URL(href, BASE_ORIGIN).searchParams.get("next"), 1);
      expect(landed, href).toBe(path);
      expect(new URL(landed!, BASE_ORIGIN).searchParams.get("q"), href).toBe(q);
      // The sign-in form gets the page's path and pushes it unchanged.
      expect(safeReturnPath(landed, 1), path).toBe(path);
    }
    // Still encoded in the path after the one decode: home page.
    expect(safeReturnPath("/tasks/T1%2Fx", 1)).toBeNull();
    expect(safeReturnPath("/tasks/100%25", 1)).toBeNull();
  });

  it("rejects a missing, empty or oversized value", () => {
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath("")).toBeNull();
    expect(safeReturnPath("   ")).toBeNull();
    expect(safeReturnPath("/" + "a".repeat(3000))).toBeNull();
    expect(signInHref(null)).toBe("/signin");
    expect(signInHref("/")).toBe("/signin");
  });

  it("sign-in links stay on /signin and round-trip a safe path", () => {
    const attacks = ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/%2f%2fevil.example", "/%5Cevil.example", null, "/", ""];
    for (const next of attacks) {
      const href = signInHref(next);
      expect(href.startsWith("/signin"), href).toBe(true);
      expect(href.startsWith("//"), href).toBe(false);
      expect(href.includes("://"), href).toBe(false);
      expect(href.includes("evil.example"), href).toBe(false);
      expect(href.includes("javascript"), href).toBe(false);
      expect(new URL(href, BASE_ORIGIN).origin).toBe(BASE_ORIGIN);
    }
    const href = signInHref("/tasks/T1");
    expect(href).toBe("/signin?next=%2Ftasks%2FT1");
    expect(safeReturnPath(new URL(href, BASE_ORIGIN).searchParams.get("next"))).toBe("/tasks/T1");
    const expired = signInHref("/tasks/T1", { expired: true });
    expect(expired).toBe("/signin?expired=1&next=%2Ftasks%2FT1");
    expect(new URL(expired, BASE_ORIGIN).searchParams.get("expired")).toBe("1");
    expect(safeReturnPath(new URL(expired, BASE_ORIGIN).searchParams.get("next"))).toBe("/tasks/T1");
    const withQuery = signInHref("/projects/abc?task=T1");
    expect(safeReturnPath(new URL(withQuery, BASE_ORIGIN).searchParams.get("next"))).toBe("/projects/abc?task=T1");
    expectSafe(safeReturnPath("/tasks/T1"));
  });

  it("a 401 sends the browser to /signin with expired=1 and the safe return path", () => {
    expect(sessionSignInTarget("/tasks/T1")).toBe("/signin?expired=1&next=%2Ftasks%2FT1");
    expect(sessionSignInTarget("/projects/abc", "?task=T1")).toBe("/signin?expired=1&next=%2Fprojects%2Fabc%3Ftask%3DT1");
    const both = sessionSignInTarget("/tasks/T1", "");
    const url = new URL(both!, BASE_ORIGIN);
    expect(url.pathname).toBe("/signin");
    expect(url.searchParams.get("expired")).toBe("1");
    expect(url.searchParams.get("next")).toBe("/tasks/T1");
    expect(safeReturnPath(url.searchParams.get("next"))).toBe("/tasks/T1");
    // No page to return to: expired=1 only, then sign-in goes home.
    expect(sessionSignInTarget("/")).toBe("/signin?expired=1");
  });

  it("a 401 does not redirect when the browser is already on /signin or /signin/", () => {
    expect(isSignInScreen("/signin")).toBe(true);
    expect(isSignInScreen("/signin/")).toBe(true);
    expect(isSignInScreen("/tasks/T1")).toBe(false);
    expect(sessionSignInTarget("/signin")).toBeNull();
    expect(sessionSignInTarget("/signin", "?expired=1&next=%2Ftasks%2FT1")).toBeNull();
    expect(sessionSignInTarget("/signin/")).toBeNull();
    expect(sessionSignInTarget("/signin/", "?expired=1&next=%2Ftasks%2FT1")).toBeNull();
  });

  it("expired=1 and a return path both appear, and an unsafe path keeps only expired=1", () => {
    const href = signInHref("/tasks/T1", { expired: true });
    const url = new URL(href, BASE_ORIGIN);
    expect(url.origin).toBe(BASE_ORIGIN);
    expect(url.searchParams.get("expired")).toBe("1");
    expect(url.searchParams.get("next")).toBe("/tasks/T1");
    expect(safeReturnPath(url.searchParams.get("next"))).toBe("/tasks/T1");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/%2f%2fevil.example", "/%5Cevil.example"]) {
      const landed = sessionSignInTarget(bad);
      expect(landed, bad).toBe("/signin?expired=1");
      expect(landed, bad).not.toContain("evil.example");
      expect(landed, bad).not.toContain("javascript");
      expect(new URL(landed!, BASE_ORIGIN).searchParams.get("next")).toBeNull();
    }
  });

  it("a session that expires mid-use returns to the deep link", async () => {
    const realFetch = globalThis.fetch;
    const realWindow = (globalThis as { window?: unknown }).window;
    const assigned: string[] = [];
    (globalThis as { window?: unknown }).window = {
      location: {
        pathname: "/tasks/T1",
        search: "",
        set href(value: string) { assigned.push(value); },
        get href() { return assigned.at(-1) ?? ""; },
      },
      dispatchEvent() {},
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Not signed in" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      // The person is already on the task. The next API call is the expired session.
      expect((await api("GET", "/api/tasks/T1")).status).toBe(401);
      const href = signInHref("/tasks/T1", { expired: true });
      expect(assigned).toEqual([href]);
      const url = new URL(href, BASE_ORIGIN);
      expect(url.pathname).toBe("/signin");
      expect(url.searchParams.get("expired")).toBe("1");
      expect(safeReturnPath(url.searchParams.get("next"))).toBe("/tasks/T1");
    } finally {
      globalThis.fetch = realFetch;
      (globalThis as { window?: unknown }).window = realWindow;
    }
  });

  it("a 401 from api() navigates with expired=1 and the return path, and stays on /signin and /signin/", async () => {
    const realFetch = globalThis.fetch;
    const realWindow = (globalThis as { window?: unknown }).window;
    const assigned: string[] = [];
    const place = (pathname: string, search = "") => {
      assigned.length = 0;
      (globalThis as { window?: unknown }).window = {
        location: {
          pathname,
          search,
          set href(value: string) { assigned.push(value); },
          get href() { return assigned.at(-1) ?? ""; },
        },
        dispatchEvent() {},
      };
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Not signed in" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      place("/tasks/T1");
      expect((await api("GET", "/api/tasks/T1")).status).toBe(401);
      expect(assigned).toEqual(["/signin?expired=1&next=%2Ftasks%2FT1"]);

      place("/projects/abc", "?task=T1");
      await api("GET", "/api/tasks/T1");
      expect(assigned).toEqual(["/signin?expired=1&next=%2Fprojects%2Fabc%3Ftask%3DT1"]);

      place("/signin", "?expired=1&next=%2Ftasks%2FT1");
      await api("GET", "/api/tasks/T1");
      expect(assigned).toEqual([]);

      place("/signin/", "?expired=1&next=%2Ftasks%2FT1");
      await api("GET", "/api/tasks/T1");
      expect(assigned).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      (globalThis as { window?: unknown }).window = realWindow;
    }
  });
});

/** Where a document response sends the browser. Partial prerender returns 200 and puts the redirect in the body. */
async function documentTarget(path: string) {
  const res = await fetch(BASE + path, { redirect: "manual" });
  const html = await res.text();
  const header = res.headers.get("location");
  const embedded = html.match(/NEXT_REDIRECT;replace;([^;"\\]+)/)?.[1] ?? html.match(/http-equiv="refresh" content="[^"]*url=([^"]+)"/)?.[1] ?? null;
  return { status: res.status, html, target: header ?? embedded };
}

/**
 * Whether the running server is sending people back. Unset SIGNIN_RETURN_TO is off
 * (deploy.yml and the lint workflow leave it unset). Phone checks set it to on.
 * The probe reads the server, so these cases do not depend on this process's env.
 */
let serverReturnTo: Promise<boolean> | null = null;
function serverReturnToEnabled() {
  serverReturnTo ??= documentTarget("/tasks/return-to-probe").then((doc) => {
    if (!doc.target) return false;
    try { return new URL(doc.target, BASE).searchParams.has("next"); } catch { return false; }
  });
  return serverReturnTo;
}

function assertSameOriginSignIn(target: string, next: string | null) {
  const url = new URL(target, BASE);
  expect(url.origin).toBe(new URL(BASE).origin);
  expect(url.hostname).not.toBe("evil.example");
  if (url.pathname === "/signin") {
    const got = url.searchParams.get("next");
    expect(got === null || safeReturnPath(got) === got).toBe(true);
    if (next !== null) expect(got).toBe(next);
    if (got) expect(got).not.toMatch(/evil\.example|javascript|\\/);
  }
}

describe("SIGNIN_RETURN_TO", () => {
  const previous = process.env.SIGNIN_RETURN_TO;
  function restoreEnv() {
    if (previous === undefined) delete process.env.SIGNIN_RETURN_TO;
    else process.env.SIGNIN_RETURN_TO = previous;
  }

  it("defaults off, and only 1 or on enables the return path", () => {
    delete process.env.SIGNIN_RETURN_TO;
    expect(returnToEnabled()).toBe(false);
    expect(signInHref("/tasks/T1", { expired: true })).toBe("/signin");
    expect(signedOutSignInHref("/tasks/T1")).toBe("/signin");
    expect(sessionSignInTarget("/tasks/T1")).toBe("/signin");
    for (const off of ["", "0", "off", "false", "no", "true", "yes", "enable"]) {
      process.env.SIGNIN_RETURN_TO = off;
      expect(returnToEnabled(), JSON.stringify(off)).toBe(false);
      expect(signInHref("/tasks/T1", { expired: true }), JSON.stringify(off)).toBe("/signin");
    }
    for (const on of ["1", "on", "ON", "On", " 1 ", " on "]) {
      process.env.SIGNIN_RETURN_TO = on;
      expect(returnToEnabled(), JSON.stringify(on)).toBe(true);
      expect(signInHref("/tasks/T1", { expired: true }), JSON.stringify(on)).toBe("/signin?expired=1&next=%2Ftasks%2FT1");
    }
    restoreEnv();
  });

  it("when off, next and expired are ignored and a 401 goes to /signin like main", async () => {
    const realFetch = globalThis.fetch;
    const realWindow = (globalThis as { window?: unknown }).window;
    const assigned: string[] = [];
    const place = (pathname: string) => {
      assigned.length = 0;
      (globalThis as { window?: unknown }).window = {
        location: {
          pathname,
          search: "",
          set href(value: string) { assigned.push(value); },
          get href() { return assigned.at(-1) ?? ""; },
        },
        dispatchEvent() {},
      };
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Not signed in" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    process.env.SIGNIN_RETURN_TO = "off";
    try {
      expect(returnToEnabled()).toBe(false);
      expect(signInHref("/tasks/T1", { expired: true })).toBe("/signin");
      expect(signInHref("https://evil.example")).toBe("/signin");
      expect(signedOutSignInHref("/tasks/T1?tab=comments")).toBe("/signin");
      expect(sessionSignInTarget("/tasks/T1")).toBe("/signin");
      expect(sessionSignInTarget("/signin", "?next=%2Ftasks%2FT1")).toBe("/signin");
      for (const off of ["off", "0", "false", "no"]) {
        process.env.SIGNIN_RETURN_TO = off;
        expect(returnToEnabled(), off).toBe(false);
      }
      process.env.SIGNIN_RETURN_TO = "off";
      place("/tasks/T1");
      expect((await api("GET", "/api/tasks/T1")).status).toBe(401);
      expect(assigned).toEqual(["/signin"]);
      place("/signin");
      await api("GET", "/api/tasks/T1");
      expect(assigned).toEqual(["/signin"]);
    } finally {
      globalThis.fetch = realFetch;
      (globalThis as { window?: unknown }).window = realWindow;
      restoreEnv();
    }
  });

  it("TC-APL2652-0f4e53e7@v1 sends no sho_return_to cookie", async () => {
    const previousWindow = (globalThis as { window?: unknown }).window;
    try {
      for (const value of [undefined, "", "0", "off", "false", "true", "yes", "on", "1", "ON"] as const) {
        if (value === undefined) delete process.env.SIGNIN_RETURN_TO;
        else process.env.SIGNIN_RETURN_TO = value;
        const res = await proxy(new NextRequest("http://localhost:3100/tasks/T1?tab=comments"));
        const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
        const joined = [...setCookie, res.headers.get("set-cookie") ?? ""].join("\n");
        expect(joined, value ?? "unset").not.toMatch(/sho_return_to/i);
        expect(joined.trim(), value ?? "unset").toBe("");
      }
      // A document from the running server matches main: no sho_return_to cookie, flag on or off.
      for (const path of ["/signin", "/signin?expired=1", "/tasks/T1"]) {
        const res = await fetch(BASE + path, { redirect: "manual" });
        const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
        const joined = [...setCookie, res.headers.get("set-cookie") ?? ""].join("\n");
        expect(joined, path).not.toMatch(/sho_return_to/i);
        await res.arrayBuffer();
      }
      // A cookie does not turn the client path on. Only the server-rendered window flag does.
      delete process.env.SIGNIN_RETURN_TO;
      (globalThis as { window?: Window & { __SHO_RETURN_TO?: number }; document?: { cookie: string } }).document = { cookie: "sho_return_to=1" };
      (globalThis as { window?: { location: { pathname: string; search: string }; __SHO_RETURN_TO?: number } }).window = {
        location: { pathname: "/tasks/T1", search: "" },
      };
      expect(returnToEnabled()).toBe(false);
      (globalThis as { window?: { location: { pathname: string; search: string }; __SHO_RETURN_TO?: number } }).window = {
        location: { pathname: "/tasks/T1", search: "" },
        __SHO_RETURN_TO: 1,
      };
      expect(returnToEnabled()).toBe(true);
    } finally {
      (globalThis as { window?: unknown }).window = previousWindow;
      delete (globalThis as { document?: { cookie: string } }).document;
      restoreEnv();
    }
  });
});

describe("APL-2652 signed-out redirect", () => {
  it("AC1 sends a signed-out deep link to sign-in with that path, and does not reuse another path", async () => {
    const enabled = await serverReturnToEnabled();
    for (const [path, next] of [
      ["/tasks/alpha-return", "/tasks/alpha-return"],
      ["/projects/beta-return?task=1", "/projects/beta-return?task=1"],
    ] as const) {
      const doc = await documentTarget(path);
      expect(doc.target, path).toBeTruthy();
      const url = new URL(doc.target!, BASE);
      expect(url.pathname).toBe("/signin");
      if (enabled) assertSameOriginSignIn(doc.target!, next);
      else {
        expect(url.searchParams.get("next"), path).toBeNull();
        assertSameOriginSignIn(doc.target!, null);
      }
    }
  });

  it("AC2 does not redirect off the app for an encoded or backslash path", async () => {
    for (const path of ["/%5Cevil.example", "/%2F%2Fevil.example", "/%252F%252Fevil.example", "/%09/evil.example"]) {
      const doc = await documentTarget(path);
      expect(doc.html, path).not.toMatch(/url=https?:\/\/evil|NEXT_REDIRECT;replace;https?:|url=\/\/evil/i);
      const header = doc.target;
      if (!header) {
        expect(doc.status, path).toBeGreaterThanOrEqual(200);
        continue;
      }
      assertSameOriginSignIn(header, null);
    }
  });

  it("AC2 the sign-in page does not redirect to an off-site next", async () => {
    for (const next of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      const doc = await documentTarget(`/signin?next=${encodeURIComponent(next)}`);
      expect(doc.status, next).toBe(200);
      expect(doc.target, next).toBeNull();
      expect(doc.html, next).not.toMatch(/url=https?:\/\/evil|NEXT_REDIRECT;replace;https?:|url=\/\/evil|url=javascript:/i);
    }
  });

  it("expired=1 shows the session alert, and a safe return path is kept with it", async () => {
    const sentence = "Your session has expired, please sign in again";
    const alert = `<div role="alert"[^>]*>${sentence}</div>`;
    const enabled = await serverReturnToEnabled();
    if (!enabled) {
      // Unset or off: next and expired are ignored, the same as main.
      for (const path of [`/signin?expired=1&next=${encodeURIComponent("/tasks/T1")}`, "/signin?expired=1", "/signin"]) {
        const doc = await documentTarget(path);
        expect(doc.status, path).toBe(200);
        expect(doc.target, path).toBeNull();
        expect(doc.html, path).not.toContain(sentence);
        expect(doc.html, path).not.toContain('\\"next\\":\\"/tasks/T1\\"');
      }
      return;
    }
    const both = await documentTarget(`/signin?expired=1&next=${encodeURIComponent("/tasks/T1")}`);
    expect(both.status).toBe(200);
    expect(both.target).toBeNull();
    expect(both.html).toMatch(new RegExp(alert));
    expect(both.html).toContain('\\"sessionExpired\\":true');
    expect(both.html).toContain('\\"next\\":\\"/tasks/T1\\"');

    const expiredOnly = await documentTarget("/signin?expired=1");
    expect(expiredOnly.html).toMatch(new RegExp(alert));
    expect(expiredOnly.html).toContain('\\"next\\":\\"$undefined\\"');

    const plain = await documentTarget("/signin");
    expect(plain.html).not.toContain(sentence);
    expect(plain.html).toContain('\\"sessionExpired\\":false');

    const evil = await documentTarget(`/signin?expired=1&next=${encodeURIComponent("https://evil.example")}`);
    expect(evil.html).toMatch(new RegExp(alert));
    expect(evil.html).toContain('\\"next\\":\\"$undefined\\"');
    expect(evil.html).not.toContain('\\"next\\":\\"https://evil.example\\"');
  });

  it("a no-access 404 and a not-found 404 match in status, title and body apart from the id", async () => {
    const owner = await account("nfowner");
    const outsider = await account("nfout");
    const p = await project(owner, owner);
    const hidden = await task(owner, p.id, { title: "ZZ-TEST APL2652 hidden task", description: "ZZ-TEST APL2652 secret body" });
    const missing = "c".repeat(hidden.length);
    const apartFromId = (text: string) => text.split(hidden).join("ID").split(missing).join("ID");
    const titleOf = (html: string) => html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "";
    const readApi = async (id: string) => {
      const res = await fetch(`${BASE}/api/tasks/${id}`, { headers: { cookie: outsider.c.cookie }, redirect: "manual" });
      const body = Buffer.from(await res.arrayBuffer());
      const headers = [...res.headers.entries()]
        .map(([name, value]) => [name.toLowerCase(), value] as const)
        .filter(([name]) => name !== "date")
        .sort((a, b) => a[0].localeCompare(b[0]));
      return { status: res.status, body, headers };
    };
    const readPage = async (id: string) => {
      const res = await fetch(`${BASE}/tasks/${id}`, { headers: { cookie: outsider.c.cookie }, redirect: "manual" });
      const html = await res.text();
      return { status: res.status, html, title: titleOf(html) };
    };
    const denied = await readApi(hidden);
    const gone = await readApi(missing);
    expect(denied.status).toBe(404);
    expect(gone.status).toBe(denied.status);
    const deniedJson = JSON.parse(denied.body.toString("utf8")) as { error?: string; title?: string };
    const goneJson = JSON.parse(gone.body.toString("utf8")) as { error?: string; title?: string };
    expect(deniedJson.title ?? null).toBe(goneJson.title ?? null);
    expect(deniedJson.error).toBe("Task not found");
    expect(goneJson.error).toBe(deniedJson.error);
    expect(apartFromId(denied.body.toString("utf8"))).toBe(apartFromId(gone.body.toString("utf8")));
    expect(denied.body.toString("utf8")).toBe(JSON.stringify({ error: "Task not found" }));
    expect(denied.body.toString("utf8")).not.toContain("APL2652");
    expect(denied.body.toString("utf8")).not.toContain(hidden);
    expect(gone.body.toString("utf8")).not.toContain(missing);
    expect(denied.headers).toEqual(gone.headers);

    const hiddenPage = await readPage(hidden);
    const missingPage = await readPage(missing);
    expect(hiddenPage.status).toBe(404);
    expect(missingPage.status).toBe(404);
    expect(hiddenPage.html).toContain("This task isn't available");
    expect(missingPage.html).toContain("This task isn't available");
    expect(hiddenPage.title).toBe("Task · Sheet Happens Officer");
    expect(missingPage.title).toBe(hiddenPage.title);
    expect(hiddenPage.html).not.toContain("ZZ-TEST APL2652 hidden task");
    expect(hiddenPage.html).not.toContain("ZZ-TEST APL2652 secret body");
    expect(missingPage.html).not.toContain("ZZ-TEST APL2652 hidden task");
    expect(missingPage.html).not.toContain("ZZ-TEST APL2652 secret body");
    expect(hiddenPage.html).not.toContain("Project not found");
    expect(missingPage.html).not.toContain("Project not found");
    // The flight script order is not stable. The document the person sees, apart from the id, is.
    const visible = (html: string) => apartFromId(html).replace(/<script[\s\S]*?<\/script>/gi, "");
    expect(visible(hiddenPage.html)).toBe(visible(missingPage.html));
  });

  it("a signed-in person is not sent to sign-in", async () => {
    const a = await account("returnstay");
    const res = await fetch(`${BASE}/projects`, { headers: { cookie: a.c.cookie }, redirect: "manual" });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(html).not.toContain("NEXT_REDIRECT;replace;/signin");
  });
});
