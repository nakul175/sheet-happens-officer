// APL-2652. Same-origin return path after sign-in, and the signed-out redirect that carries it.
// The cases at the top do not need a server. The "signed-out redirect" cases hit TASKBOARD_URL.
import { describe, expect, it } from "vitest";
import { api } from "@/components/api";
import { account, BASE, project, task } from "./helpers";
import { isSignInScreen, returnToActive, returnToEnabled, safeReturnPath, sessionSignInTarget, signedOutSignInHref, signInHref } from "@/lib/return-to";

const BASE_ORIGIN = "http://return.invalid";

function expectSafe(path: string | null) {
  expect(path, "a safe path").toBeTruthy();
  expect(path!.startsWith("/"), path!).toBe(true);
  expect(path!.startsWith("//"), path!).toBe(false);
  expect(path).not.toMatch(/[\\\u0000-\u001F\u007F]/);
  expect(new URL(path!, BASE_ORIGIN).origin).toBe(BASE_ORIGIN);
}

describe("APL-2652 safe return path", () => {
  it("keeps a same-origin deep link, including a query and a hash", () => {
    expect(safeReturnPath("/tasks/T1")).toBe("/tasks/T1");
    expect(safeReturnPath("  /tasks/T1  ")).toBe("/tasks/T1");
    expect(safeReturnPath("/tasks/T1?x=1")).toBe("/tasks/T1?x=1");
    expect(safeReturnPath("/projects/abc?task=T1")).toBe("/projects/abc?task=T1");
    expect(safeReturnPath("/projects/abc?task=T1#panel")).toBe("/projects/abc?task=T1#panel");
    expect(safeReturnPath("/")).toBe("/");
    expect(safeReturnPath("%2Ftasks%2FT1")).toBe("/tasks/T1");
    expect(safeReturnPath("%2Fprojects%2Fabc%3Ftask%3DT1")).toBe("/projects/abc?task=T1");
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

  it("defaults on, and keeps expired=1 with the safe return path", () => {
    delete process.env.SIGNIN_RETURN_TO;
    expect(returnToEnabled()).toBe(true);
    expect(signInHref("/tasks/T1", { expired: true })).toBe("/signin?expired=1&next=%2Ftasks%2FT1");
    expect(signedOutSignInHref("/tasks/T1")).toBe("/signin?next=%2Ftasks%2FT1");
    for (const on of ["on", "1", "true", "yes"]) {
      process.env.SIGNIN_RETURN_TO = on;
      expect(returnToEnabled(), on).toBe(true);
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

  it("the browser cookie turns the same 401 off and on", async () => {
    const realFetch = globalThis.fetch;
    const realWindow = (globalThis as { window?: unknown }).window;
    const realDocument = (globalThis as { document?: { cookie: string } }).document;
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
    delete process.env.SIGNIN_RETURN_TO;
    try {
      (globalThis as { document?: { cookie: string } }).document = { cookie: "sho_return_to=0" };
      expect(returnToActive()).toBe(false);
      await api("GET", "/api/tasks/T1");
      expect(assigned).toEqual(["/signin"]);

      assigned.length = 0;
      (globalThis as { document?: { cookie: string } }).document = { cookie: "sho_return_to=1" };
      expect(returnToActive()).toBe(true);
      await api("GET", "/api/tasks/T1");
      expect(assigned).toEqual([signInHref("/tasks/T1", { expired: true })]);
    } finally {
      globalThis.fetch = realFetch;
      (globalThis as { window?: unknown }).window = realWindow;
      (globalThis as { document?: { cookie: string } }).document = realDocument;
      restoreEnv();
    }
  });
});

describe("APL-2652 signed-out redirect", () => {
  it("AC1 sends a signed-out deep link to sign-in with that path, and does not reuse another path", async () => {
    for (const [path, next] of [
      ["/tasks/alpha-return", "/tasks/alpha-return"],
      ["/projects/beta-return?task=1", "/projects/beta-return?task=1"],
    ] as const) {
      const doc = await documentTarget(path);
      expect(doc.target, path).toBeTruthy();
      assertSameOriginSignIn(doc.target!, next);
      expect(new URL(doc.target!, BASE).pathname).toBe("/signin");
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

  it("a no-access task and a missing task return the same 404 body and headers", async () => {
    const owner = await account("nfowner");
    const outsider = await account("nfout");
    const p = await project(owner, owner);
    const hidden = await task(owner, p.id, { title: "APL2652 hidden task", description: "APL2652 secret body" });
    const missing = "cmmissingtask000000000000";
    const read = async (id: string) => {
      const res = await fetch(`${BASE}/api/tasks/${id}`, { headers: { cookie: outsider.c.cookie }, redirect: "manual" });
      const body = Buffer.from(await res.arrayBuffer());
      const headers = [...res.headers.entries()]
        .map(([name, value]) => [name.toLowerCase(), value] as const)
        .filter(([name]) => name !== "date")
        .sort((a, b) => a[0].localeCompare(b[0]));
      return { status: res.status, body, headers };
    };
    const denied = await read(hidden);
    const gone = await read(missing);
    expect(denied.status).toBe(404);
    expect(gone.status).toBe(404);
    expect(Buffer.compare(denied.body, gone.body)).toBe(0);
    expect(denied.body.toString("utf8")).toBe(JSON.stringify({ error: "Task not found" }));
    expect(denied.body.toString("utf8")).not.toContain("APL2652");
    expect(denied.headers).toEqual(gone.headers);
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
