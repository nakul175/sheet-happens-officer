// APL-2652. Same-origin return path after sign-in, and the signed-out redirect that carries it.
// The cases at the top do not need a server. The "signed-out redirect" cases hit TASKBOARD_URL.
import { describe, expect, it } from "vitest";
import { account, BASE } from "./helpers";
import { safeReturnPath, sessionSignInTarget, signInHref } from "@/lib/return-to";

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

  it("APL-2664 a 401 keeps expired=1, adds a safe return path, and does not leave /signin", () => {
    expect(sessionSignInTarget("/tasks/T1")).toBe("/signin?expired=1&next=%2Ftasks%2FT1");
    expect(sessionSignInTarget("/projects/abc", "?task=T1")).toBe("/signin?expired=1&next=%2Fprojects%2Fabc%3Ftask%3DT1");
    expect(sessionSignInTarget("/")).toBe("/signin?expired=1");
    // Already on the sign-in screen: do not navigate, so next in the query is left as it is.
    expect(sessionSignInTarget("/signin")).toBeNull();
    expect(sessionSignInTarget("/signin", "?next=%2Ftasks%2FT1&expired=1")).toBeNull();
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/%2f%2fevil.example", "/%5Cevil.example"]) {
      const href = sessionSignInTarget(bad);
      expect(href, bad).toBe("/signin?expired=1");
      expect(href, bad).not.toContain("evil.example");
      expect(href, bad).not.toContain("javascript");
      expect(new URL(href!, BASE_ORIGIN).origin).toBe(BASE_ORIGIN);
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

  it("a signed-in person is not sent to sign-in", async () => {
    const a = await account("returnstay");
    const res = await fetch(`${BASE}/projects`, { headers: { cookie: a.c.cookie }, redirect: "manual" });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(html).not.toContain("NEXT_REDIRECT;replace;/signin");
  });
});
