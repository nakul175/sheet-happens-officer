// APL-2652. Same-origin return path after sign-in, and the signed-out redirect that carries it.
// The cases at the top do not need a server. The "signed-out redirect" cases hit TASKBOARD_URL.
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { api } from "@/components/api";
import { proxy } from "@/proxy";
import { account, BASE, project, SUPER_EMAIL, task } from "./helpers";
import { hashToken, SESSION_COOKIE } from "@/lib/auth";
import { db } from "@/lib/db";
import { isSignInScreen, RETURN_PATH_HEADER, returnToEnabled, safeReturnPath, sessionSignInTarget, signedOutSignInHref, signInHref } from "@/lib/return-to";

const BASE_ORIGIN = "http://return.invalid";
/** A decoded tab, CR, LF or other control character. A header or a log line must never carry one from `next`. */
const RAW_CONTROL = /[\u0000-\u001F\u007F]/;
/**
 * Places in a server log where a v16 probe value appears with a raw control character, LF included. The probe values
 * are a%09b, a%0Ab and a%0D%0Ab, so anything between "v16-probe?q=a" and the closing "b" must be ASCII text.
 */
function serverLogLeaks(text: string): string[] {
  const leaks: string[] = [];
  for (const m of text.matchAll(/v16-probe\?q=a([\s\S]{0,12}?)b/g)) {
    if (/[\u0000-\u001F\u007F]/.test(m[1])) leaks.push(JSON.stringify(m[0]));
  }
  return leaks;
}

/** The same, minus the line ending a log write ends with. */
const RAW_CONTROL_IN_LINE = /[\u0000-\u0009\u000B-\u001F\u007F]|\n(?!$)/;

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
    expect(safeReturnPath("  /tasks/T1  ")).toBeNull();
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
      "/%20/evil.example",
      "/tasks/a b",
      "/tasks/a\u00A0b",
    ]) {
      expect(safeReturnPath(next), next).toBeNull();
      expect(signInHref(next), next).toBe("/signin");
    }
    // AC2 v1.5 (Pam's D6): the encoded-whitespace reject is for the path only. A query value a%20b keeps the return path.
    expect(signInHref("/tasks/T1?tab=a%20b")).toBe("/signin?next=%2Ftasks%2FT1%3Ftab%3Da%2520b");
    expect(safeReturnPath("/tasks/T1?tab=a%20b", 1)).toBe("/tasks/T1?tab=a%20b");
    expect(safeReturnPath("/tasks/a%20b", 1)).toBeNull();
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

  it("qa:TC-APL2652-c26e8af9@v2 AC2 v1.4: decodes once, counting the router's decode; 5x-encoded lands on /", () => {
    const encode = (value: string, times: number) => {
      let out = value;
      for (let i = 0; i < times; i++) out = encodeURIComponent(out);
      return out;
    };
    // The router decodes the query once. That is the one decode, so a path still encoded after it falls back.
    expect(safeReturnPath(decodeURIComponent(encode("/tasks/T1?tab=comments", 1)), 1)).toBe("/tasks/T1?tab=comments");
    expect(safeReturnPath(decodeURIComponent(encode("/tasks/T1?tab=comments", 2)), 1)).toBeNull();
    expect(safeReturnPath(decodeURIComponent(encode("/tasks/T1?tab=comments", 5)), 1)).toBeNull();
    expect(signInHref(decodeURIComponent(encode("/tasks/T1?tab=comments", 5)))).toBe("/signin");
    expect(safeReturnPath(decodeURIComponent(encode("/tasks/T1?tab=comments", 6)), 1)).toBeNull();
    expect(safeReturnPath(decodeURIComponent(encode("//evil.example", 2)), 1)).toBeNull();
    // The 17 Examples rows of AC2 v1.2, unchanged in v1.4. Each is sent as /signin?next=<row>, both as written and
    // URL-encoded, and is decoded exactly once by the router before safeReturnPath sees it. Every one lands on /.
    const rows = [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "%2F%2Fevil.example",
      "/%5Cevil.example",
      "/%09/evil.example",
      " //evil.example",
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,ZZ-TEST-INJECT",
      "https:evil.example",
      "https://return.invalid.evil.example",
      "https://return.invalid@evil.example",
      "",
      "/api/tasks",
      "/signin",
      "/signin?next=/tasks/T1",
    ];
    for (const row of rows) {
      for (const sent of [row, encodeURIComponent(row)]) {
        const seen = new URL(`/signin?next=${sent}`, BASE_ORIGIN).searchParams.get("next");
        expect(safeReturnPath(seen, 1), `next=${sent}`).toBeNull();
      }
      expect(signInHref(row), row).toBe("/signin");
    }
    // Missing next.
    expect(safeReturnPath(new URL("/signin", BASE_ORIGIN).searchParams.get("next"), 1)).toBeNull();
    // /api/ and /signin are rejected after the one decode, including when they only appear once decoded.
    for (const sent of ["%2Fapi%2Ftasks", "%2Fapi%2Ftasks%3Fx%3D1", "%2Fsignin", "%2Fsignin%3Fnext%3D%2Ftasks%2FT1", "%2Fsignin%2F"]) {
      const seen = new URL(`/signin?next=${sent}`, BASE_ORIGIN).searchParams.get("next");
      expect(safeReturnPath(seen, 1), sent).toBeNull();
    }
    // A path still %-encoded after the one decode is rejected (the query keeps its encoding per the 19:06 ruling).
    expect(safeReturnPath(new URL("/signin?next=%2Ftasks%252FT1", BASE_ORIGIN).searchParams.get("next"), 1)).toBeNull();
    expect(safeReturnPath(new URL("/signin?next=%2F%2561pi%2Ftasks", BASE_ORIGIN).searchParams.get("next"), 1)).toBeNull();
  });

  it("AC2 v1.4 rejects whitespace or a control character at either end instead of trimming it", () => {
    // Pam's D1 (6280676456): the router decodes `next`, so these reach safeReturnPath with the character in place.
    for (const next of [
      "%20%2Ftasks%2FT1", // leading space
      "%2Ftasks%2FT1%20", // trailing space
      "%09%2Ftasks%2FT1", // leading tab
      "%2Ftasks%2FT1%09", // trailing tab
      "%01%2Ftasks%2FT1", // leading control character
      "%2Ftasks%2FT1%0A", // trailing line feed
      "%2Ftasks%2FT1%3Fa%3D%0D%0A", // trailing CR LF in the query
    ]) {
      const seen = new URL(`/signin?next=${next}`, BASE_ORIGIN).searchParams.get("next");
      expect(safeReturnPath(seen, 1), next).toBeNull();
      expect(safeReturnPath(next), next).toBeNull();
      expect(signInHref(seen), next).toBe("/signin");
    }
    expect(safeReturnPath(" /tasks/T1")).toBeNull();
    expect(safeReturnPath("/tasks/T1\t")).toBeNull();
    expect(safeReturnPath("/tasks/T1\u0001")).toBeNull();
  });

  it("D6 AC2 v1.5: encoded whitespace is a path rule; a query value keeps it", () => {
    // Pam's D6 (6283329986): ?q=a%20b is a query value, decoded once and kept as "a b".
    const landed = safeReturnPath(new URL("/signin?next=%2Ftasks%2FT1%3Fq%3Da%2520b", BASE_ORIGIN).searchParams.get("next"), 1);
    expect(landed).toBe("/tasks/T1?q=a%20b");
    expect(new URL(landed!, BASE_ORIGIN).searchParams.get("q")).toBe("a b");
    expect(signInHref("/tasks/T1?q=a%20b")).toBe("/signin?next=%2Ftasks%2FT1%3Fq%3Da%2520b");
    expect(safeReturnPath("/tasks/T1?tab=a%20b", 1)).toBe("/tasks/T1?tab=a%20b");
    // The same encodings in the path are still rejected.
    for (const path of ["/tasks/a%20b", "/tasks/T1%09", "/tasks/T1%0A", "/tasks/T1%0d"]) {
      expect(safeReturnPath(path, 1), path).toBeNull();
      expect(signInHref(path), path).toBe("/signin");
    }
  });

  it("D8 a literal space in a query value keeps the return path; whitespace in the path is still rejected", () => {
    // Pam's D8 (6283719658): the router turns q%3Da%20b into a literal space in the query.
    const landed = safeReturnPath(new URL("/signin?next=%2Ftasks%2FT1%3Fq%3Da%20b", BASE_ORIGIN).searchParams.get("next"), 1);
    expect(landed).toBe("/tasks/T1?q=a%20b");
    expect(new URL(landed!, BASE_ORIGIN).searchParams.get("q")).toBe("a b");
    expect(safeReturnPath("/tasks/T1?q=a\u00A0b", 1)).toBe("/tasks/T1?q=a%C2%A0b");
    for (const path of ["/tasks/a b", "/tasks/a\u00A0b", "/tasks/a\u3000b", "/tasks/T1 ?q=x"]) {
      expect(safeReturnPath(path, 1), path).toBeNull();
      expect(signInHref(path), path).toBe("/signin");
    }
    // A literal control character is still rejected anywhere, query included.
    for (const value of ["/tasks/T1?q=a\tb", "/tasks/T1?q=a\nb", "/tasks/T1?q=a\rb", "/tasks/T1?q=a\u0001b"]) {
      expect(safeReturnPath(value, 1), JSON.stringify(value)).toBeNull();
    }
  });

  it("D9 AC2 v1.6: encoded %09 and %0A in a query value are kept encoded and never emitted raw", () => {
    for (const [sent, q] of [["%2Ftasks%2FT1%3Fq%3Da%2509b", "a\tb"], ["%2Ftasks%2FT1%3Fq%3Da%250Ab", "a\nb"], ["%2Ftasks%2FT1%3Fq%3Da%250D%250Ab", "a\r\nb"]]) {
      const landed = safeReturnPath(new URL(`/signin?next=${sent}`, BASE_ORIGIN).searchParams.get("next"), 1);
      expect(landed, sent).toBeTruthy();
      expect(landed!, sent).not.toMatch(/[\u0000-\u001F\u007F]/);
      expect(landed!.startsWith("/tasks/T1?q=a%"), landed!).toBe(true);
      expect(new URL(landed!, BASE_ORIGIN).searchParams.get("q"), sent).toBe(q);
      // The 401 and signed-out paths carry it the same way, still encoded.
      const href = signInHref(landed);
      expect(href).not.toMatch(/[\u0000-\u001F\u007F]/);
      expect(safeReturnPath(new URL(href, BASE_ORIGIN).searchParams.get("next"), 1)).toBe(landed);
    }
    // The same encodings in the path are rejected.
    expect(safeReturnPath("/tasks/T1%09", 1)).toBeNull();
    expect(safeReturnPath("/tasks/T1%0A", 1)).toBeNull();
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

describe("APL-2652 expiry on a live browser: AC6 v1.2 keeps the target, AC7 v1.2 changes nothing", () => {
  // This file runs from a test process whose environment may itself carry SIGNIN_RETURN_TO=on (a mode server).
  // The checks below are about the running server's flag, like every other case in the file, so the flag is turned
  // off here and read back from the server instead.
  const previous = process.env.SIGNIN_RETURN_TO;
  afterEach(() => {
    if (previous === undefined) delete process.env.SIGNIN_RETURN_TO;
    else process.env.SIGNIN_RETURN_TO = previous;
  });

  /**
   * A session row whose expiry is already past, and whose `lastSeenAt` is recent so `sessionUser` does not write to it.
   * `sessionUser` looks the token up by its hash and refuses it on `expiresAt`, so the app treats the browser as signed out.
   */
  async function expiredCookie(): Promise<string> {
    const user = await db.user.findUniqueOrThrow({ where: { email: SUPER_EMAIL } });
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    await db.session.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() - 60_000), lastSeenAt: now, userAgent: "qa:APL-2652 expired session" },
    });
    return `${SESSION_COOKIE}=${token}`;
  }

  /** Every Set-Cookie line a response carries. `headers.getSetCookie` exists on Node's fetch; the fallback keeps older stubs honest. */
  function setCookies(res: Response): string[] {
    const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const single = res.headers.get("set-cookie");
    return single && lines.length === 0 ? [single] : lines;
  }

  it("AC6 v1.2: an expired session on an app page answers 401, and the 401 target keeps the validated path and the fixed message", async () => {
    const cookie = await expiredCookie();
    // The state the browser is in: signed out, because the session row has expired.
    const api = await fetch(`${BASE}/api/tasks/T1`, { headers: { cookie }, redirect: "manual" });
    expect(api.status, "an expired session answers 401, the trigger AC6 depends on").toBe(401);
    await api.arrayBuffer();
    // The trigger above is the server's; what follows is this process's decision, so the flag is set explicitly here
    // rather than read from whatever environment this runner happens to carry (a mode server sets it to on).
    // AC8 is covered separately by the flag-off cases in SIGNIN_RETURN_TO.
    process.env.SIGNIN_RETURN_TO = "on";
    // What `src/components/api.ts` does with that 401, for the same browser.
    expect(sessionSignInTarget("/tasks/T1")).toBe("/signin?expired=1&next=%2Ftasks%2FT1");
    expect(signedOutSignInHref("/tasks/T1?tab=comments")).toBe("/signin?next=%2Ftasks%2FT1%3Ftab%3Dcomments");
    // AC6 v1.2: the next it carries passes the same AC2 validation sign-in will apply to it.
    expect(safeReturnPath("/tasks/T1")).toBe("/tasks/T1");
    // And on a server that runs with the flag on, the screen really shows the one fixed sentence and does not bounce.
    // ci.yml's server runs with the flag off, so that half is asserted only where the server has it on (phone-checks.yml,
    // viewport.yml and the mode servers all set SIGNIN_RETURN_TO=on).
    if (await serverReturnToEnabled()) {
      const screen = await documentTarget("/signin?expired=1&next=%2Ftasks%2FT1");
      expect(screen.status).toBe(200);
      expect(screen.target, "sign-in does not bounce anywhere on its own").toBeNull();
      expect(screen.html).toMatch(/<div role="alert"[^>]*>Your session has expired, please sign in again<\/div>/);
      expect(screen.html).toContain('\\"next\\":\\"/tasks/T1\\"');
    }
  });

  it("AC6 v1.2: the /team/p2 row — an expired session there answers 401, and the 401 target keeps the validated path", async () => {
    // The same case as the row above, for a person's page: `/team/<id>` is an app page with no task in it, so the
    // return path is the page itself. `person-no-access.test.tsx` already loads `/api/team/p2`, so that id is real.
    const cookie = await expiredCookie();
    const api = await fetch(`${BASE}/api/team/p2`, { headers: { cookie }, redirect: "manual" });
    expect(api.status, "an expired session on /team/p2 answers 401, the trigger AC6 depends on").toBe(401);
    await api.arrayBuffer();
    // What `src/components/api.ts` does with that 401 for /team/p2, the same way the /tasks/T1 row checks it.
    process.env.SIGNIN_RETURN_TO = "on";
    const signedIn = sessionSignInTarget("/team/p2") ?? "";
    expect(signedIn).toBe("/signin?expired=1&next=%2Fteam%2Fp2");
    // ...and the next it carries decodes to the page itself and passes the same AC2 validation sign-in will apply.
    const roundTrip = new URL(signedIn, "http://return.invalid").searchParams.get("next") ?? "";
    expect(roundTrip).toBe("/team/p2");
    expect(safeReturnPath(roundTrip)).toBe("/team/p2");
    // And on a server that runs with the flag on, the screen shows the fixed sentence and does not bounce.
    if (await serverReturnToEnabled()) {
      const screen = await documentTarget("/signin?expired=1&next=%2Fteam%2Fp2");
      expect(screen.status).toBe(200);
      expect(screen.target, "sign-in does not bounce anywhere on its own").toBeNull();
      expect(screen.html).toMatch(/<div role="alert"[^>]*>Your session has expired, please sign in again<\/div>/);
      // The same escaping as the /tasks/T1 row above: the payload carries double-escaped quotes, so the match needs two.
      expect(screen.html).toContain('\\"next\\":\\"/team/p2\\"');
    }
  });

  /** The document with every `<script>` removed: what a person can actually see, as opposed to the framework's payload. */
  function visible(html: string): string {
    return html.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, "");
  }

  it("AC7 v1.2: /signin?expired=<anything> writes and clears nothing, and renders no text from the URL", async () => {
    const enabled = await serverReturnToEnabled();
    // The tests below call the pure helpers, so the flag in this process has to match the server's.
    if (enabled) process.env.SIGNIN_RETURN_TO = "on";
    else process.env.SIGNIN_RETURN_TO = "off";
    for (const query of ["", "?expired=1", "?expired=0", "?expired=yes", "?expired=%3Cb%3Ezz-2652-ac7%3C%2Fb%3E", "?expired=1&zz-2652-ac7=1"]) {
      const path = `/signin${query}`;
      const res = await fetch(BASE + path, { redirect: "manual" });
      const html = await res.text();
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
      // AC7 v1.2: nothing written or cleared, and no session cookie touched, by opening the expired screen.
      expect(setCookies(res), path).toEqual([]);
      // The URL's own text is never shown. The framework carries the request URL in its own payload, inert, so the
      // check is on the document: no element, attribute or text node renders what the URL said.
      expect(visible(html), path).not.toContain("zz-2652-ac7");
      // ...and that check is not vacuous: the probe really is in the response (in the framework payload), and stripping
      // only the scripts is what removes it. A blank page, or a page that echoed nothing at all, would fail here.
      if (path.includes("zz-2652-ac7")) {
        expect(html, `${path}: the probe reaches the response`).toContain("zz-2652-ac7");
        expect(visible(html).length, `${path}: the document still has content`).toBeGreaterThan(1000);
      }
      // The sentence is the fixed one and appears only where it belongs: expired=1 on a flag-on server.
      const shows = /Your session has expired, please sign in again/.test(visible(html));
      expect(shows, path).toBe(query.includes("expired=1") && enabled);
    }
  });
});

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

  it("D9 AC2 v1.6: a signed-out redirect keeps %09 and %0A in a query value encoded in the Location", async () => {
    const enabled = await serverReturnToEnabled();
    for (const [path, q] of [["/tasks/v16-probe?q=a%09b", "a\tb"], ["/tasks/v16-probe?q=a%0Ab", "a\nb"], ["/tasks/v16-probe?q=a%0D%0Ab", "a\r\nb"]] as const) {
      const doc = await documentTarget(path);
      expect(doc.target, path).toBeTruthy();
      // Never raw: no decoded control character in the Location or the redirect the page carries.
      expect(doc.target!, path).not.toMatch(/[\u0000-\u001F\u007F]/);
      const next = new URL(doc.target!, BASE).searchParams.get("next");
      if (!enabled) {
        expect(next, path).toBeNull();
        continue;
      }
      expect(next, path).toBe(path);
      expect(new URL(next!, BASE).searchParams.get("q"), path).toBe(q);
    }
    // Pam's D9: no response header from the running server carries a raw tab, CR or LF.
    for (const path of ["/tasks/v16-probe?q=a%09b", "/tasks/v16-probe?q=a%0Ab", "/tasks/v16-probe?q=a%0D%0Ab"]) {
      const res = await fetch(BASE + path, { redirect: "manual" });
      await res.arrayBuffer();
      for (const [name, value] of res.headers.entries()) expect(`${name}: ${value}`, path).not.toMatch(RAW_CONTROL);
    }
    // No log line carries one either. The proxy runs in this process, so every console and stdout/stderr write is caught.
    const lines: string[] = [];
    const keep = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(keep),
      vi.spyOn(console, "info").mockImplementation(keep),
      vi.spyOn(console, "warn").mockImplementation(keep),
      vi.spyOn(console, "error").mockImplementation(keep),
      vi.spyOn(console, "debug").mockImplementation(keep),
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }),
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }),
    ];
    const forwarded: string[] = [];
    try {
      for (const path of ["/tasks/v16-probe?q=a%09b", "/tasks/v16-probe?q=a%0Ab", "/tasks/v16-probe?q=a%0D%0Ab"]) {
        const res = await proxy(new NextRequest(BASE_ORIGIN + path));
        for (const [name, value] of res.headers.entries()) expect(`${name}: ${value}`, path).not.toMatch(RAW_CONTROL);
        forwarded.push(res.headers.get(`x-middleware-request-${RETURN_PATH_HEADER}`) ?? "");
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(forwarded).toEqual(["/tasks/v16-probe?q=a%09b", "/tasks/v16-probe?q=a%0Ab", "/tasks/v16-probe?q=a%0D%0Ab"]);
    for (const line of lines) expect(line).not.toMatch(RAW_CONTROL_IN_LINE);
    // The server's own log, where CI writes it (server.log) or where SERVER_LOG points. It must exist: a missing log
    // would make this check pass without looking at anything (Pam's D11).
    const log = process.env.SERVER_LOG ?? "server.log";
    expect(existsSync(log), `server log at ${log} (set SERVER_LOG to the running server's log)`).toBe(true);
    // Scan the whole text, not line by line: splitting on LF would hide a raw LF inside a logged value (Pam's D11).
    const text = readFileSync(log, "utf8");
    // Pam's D12: the scan must have something to look at. `next start` logs no requests, so the server runs with
    // RETURN_PATH_LOG=1 and the proxy logs the return path it forwards. Each probe must be there, still encoded.
    for (const encoded of ["a%09b", "a%0Ab", "a%0D%0Ab"]) {
      expect(text, `server log has the v16-probe line for q=${encoded} (start the server with RETURN_PATH_LOG=1)`).toContain(`[return-path] /tasks/v16-probe?q=${encoded}`);
    }
    expect(serverLogLeaks(text)).toEqual([]);
  });

  it("D11 the server-log scan catches a raw LF, tab or CR LF in a logged probe value", () => {
    // Planted lines like Pam's: each raw form is found, and the encoded forms the app logs pass.
    expect(serverLogLeaks("GET /tasks/v16-probe?q=a\nb 302\n")).toHaveLength(1);
    expect(serverLogLeaks("GET /tasks/v16-probe?q=a\tb 302\n")).toHaveLength(1);
    expect(serverLogLeaks("GET /tasks/v16-probe?q=a\r\nb 302\n")).toHaveLength(1);
    expect(serverLogLeaks("GET /tasks/v16-probe?q=a%09b 302\nGET /tasks/v16-probe?q=a%0Ab 302\nGET /tasks/v16-probe?q=a%0D%0Ab 302\n")).toEqual([]);
  });

  it("D10 a space in a query value keeps its %20 through the signed-out redirect", async () => {
    // Next hands the proxy a URL rebuilt with URLSearchParams, where a space is "+" and a literal plus is "%2B".
    const forwarded = async (url: string) => (await proxy(new NextRequest(url))).headers.get(`x-middleware-request-${RETURN_PATH_HEADER}`);
    expect(await forwarded(`${BASE_ORIGIN}/tasks/T1?q=a+b`)).toBe("/tasks/T1?q=a%20b");
    expect(await forwarded(`${BASE_ORIGIN}/tasks/T1?q=a%20b`)).toBe("/tasks/T1?q=a%20b");
    expect(await forwarded(`${BASE_ORIGIN}/tasks/T1?q=C%2B%2B`)).toBe("/tasks/T1?q=C%2B%2B");
    expect(await forwarded(`${BASE_ORIGIN}/tasks/T1?q=R%26D`)).toBe("/tasks/T1?q=R%26D");
    // The running server: Pam's probe lands on ?q=a%20b, not ?q=a+b.
    const enabled = await serverReturnToEnabled();
    for (const path of ["/tasks/v10-probe?q=a%20b", "/tasks/v10-probe?q=a%2Bb"]) {
      const doc = await documentTarget(path);
      const next = new URL(doc.target!, BASE).searchParams.get("next");
      if (!enabled) {
        expect(next, path).toBeNull();
        continue;
      }
      expect(next, path).toBe(path);
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
