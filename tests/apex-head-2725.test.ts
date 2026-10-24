// SHO-2725 (APL-2661 AC1). The apex and www names answered HEAD with 405 from the forwarder in front of the host,
// while GET got the 301 to the app, so `curl -I` never showed the redirect. The proxy answers both names itself,
// for every method. Read-only: the proxy is called directly, so this needs no server, no build and no database.
// qa:TC missing: QA has not assigned TC ids for this story yet.
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { RETURN_PATH_HEADER } from "@/lib/return-to";

const APP = "https://app.sheethappensofficer.com/";
const APEX = [
  "http://sheethappensofficer.com/",
  "https://sheethappensofficer.com/",
  "http://www.sheethappensofficer.com/",
  "https://www.sheethappensofficer.com/",
] as const;

/** The proxy's answer to one request. HEAD is asked for explicitly, the way `curl -I` does. */
async function answer(url: string, method: "GET" | "HEAD" = "GET", headers?: Record<string, string>) {
  const res = await proxy(new NextRequest(url, { method, headers }));
  const body = res.body;
  return { status: res.status, location: res.headers.get("location"), body, text: body === null ? "" : await res.text() };
}

describe("SHO-2725 apex and www answer 301 to HEAD", () => {
  it.each(APEX)("AC1: HEAD %s is the same 301 to the app that GET gets", async (url) => {
    const get = await answer(url, "GET");
    const head = await answer(url, "HEAD");
    expect(head.status, `HEAD ${url}`).toBe(301);
    expect(head.location, `HEAD ${url}`).toBe(APP);
    expect({ status: head.status, location: head.location }, `HEAD ${url} matches GET`).toEqual({
      status: get.status,
      location: get.location,
    });
    // `curl -I` prints the status line and the headers. A HEAD answer carries no body.
    expect(head.body, `HEAD ${url} body`).toBeNull();
    expect(head.text, `HEAD ${url} text`).toBe("");
  });

  it("AC1: HEAD keeps the path and query, so an apex deep link lands on the same screen", async () => {
    const url = "https://www.sheethappensofficer.com/tasks/T1?tab=comments";
    const head = await answer(url, "HEAD");
    const get = await answer(url, "GET");
    expect(head.status).toBe(301);
    expect(head.location).toBe("https://app.sheethappensofficer.com/tasks/T1?tab=comments");
    expect(head.location).toBe(get.location);
  });

  it("AC2: the app keeps its own answer and staging is not redirected to the app", async () => {
    for (const url of ["https://app.sheethappensofficer.com/", "https://staging.sheethappensofficer.com/"]) {
      for (const method of ["GET", "HEAD"] as const) {
        const res = await answer(url, method);
        // NextResponse.next(): routing carries on, so the app answers 200 and staging's basic-auth gate answers 401.
        expect(res.status, `${method} ${url}`).toBe(200);
        expect(res.location, `${method} ${url}`).toBeNull();
      }
    }
  });

  it("AC1: a forwarded host, a port, the root dot and upper case name the same host", async () => {
    // Caddy in front of the app forwards the name it was asked for; that name decides the redirect.
    const forwarded = await answer("http://127.0.0.1:3000/", "HEAD", {
      "x-forwarded-host": "www.sheethappensofficer.com, 127.0.0.1:3000",
    });
    expect(forwarded.status, "x-forwarded-host").toBe(301);
    expect(forwarded.location, "x-forwarded-host").toBe(APP);

    for (const url of ["https://WWW.sheethappensofficer.com./", "http://sheethappensofficer.com:8080/"]) {
      const head = await answer(url, "HEAD");
      expect(head.status, url).toBe(301);
      expect(head.location, url).toBe(APP);
    }
  });

  it("AC1: a path that looks like another host stays on the app", async () => {
    const head = await answer("https://sheethappensofficer.com//evil.example/x", "HEAD");
    expect(head.status).toBe(301);
    expect(new URL(head.location!).origin).toBe("https://app.sheethappensofficer.com");
  });

  it("the app still gets the return path the proxy forwards", async () => {
    // Not /tasks/*: that path reads the session, which this file deliberately does not need.
    const res = await proxy(new NextRequest("https://app.sheethappensofficer.com/projects?view=mine"));
    expect(res.headers.get(`x-middleware-request-${RETURN_PATH_HEADER}`)).toBe("/projects?view=mine");
  });
});
