// SHO-2725 (APL-2661 AC1) at HTTP level. tests/apex-head-2725.test.ts calls the proxy directly, which cannot show
// whether the request ever reaches it: an apex path that the matcher skipped was answered by the app itself with 200.
// This file asks a running server, so the matcher is part of what is under test. Caddy in front of the app forwards
// the name it was asked for in X-Forwarded-Host, so that header names the host here too.
// qa:TC missing: QA has not assigned TC ids for this story yet.
import { describe, expect, it } from "vitest";

const BASE = (process.env.TASKBOARD_URL ?? "http://localhost:3000").replace(/\/$/, "");
const APP = "https://app.sheethappensofficer.com";

/** One request as the edge forwards it: the original name in X-Forwarded-Host, not followed. */
async function ask(host: string, path: string, method: "GET" | "HEAD") {
  const res = await fetch(BASE + path, {
    method,
    redirect: "manual",
    headers: { "x-forwarded-host": host },
  });
  // HEAD carries no body; a GET one is read so the response is complete before the next request.
  const body = method === "GET" ? await res.arrayBuffer() : null;
  return { status: res.status, location: res.headers.get("location"), bytes: body?.byteLength ?? null };
}

const APEX_HOSTS = ["sheethappensofficer.com", "www.sheethappensofficer.com"] as const;

describe("SHO-2725 apex and www answer 301 to HEAD over HTTP", () => {
  it.each(APEX_HOSTS)("%s: HEAD and GET answer 301 to the app for the root", async (host) => {
    const head = await ask(host, "/", "HEAD");
    const get = await ask(host, "/", "GET");
    expect(head.status, `HEAD ${host}/`).toBe(301);
    expect(get.status, `GET ${host}/`).toBe(301);
    expect(head.location, `HEAD ${host}/`).toBe(`${APP}/`);
    expect(get.location, `GET ${host}/`).toBe(`${APP}/`);
    // `curl -I` prints the status line and headers; a HEAD answer has no body.
    expect(head.bytes, `HEAD ${host}/ body`).toBeNull();
  });

  it.each(APEX_HOSTS)("%s: HEAD and GET keep the path and query on a deep link", async (host) => {
    const path = "/tasks/APL-2661?tab=comments";
    const head = await ask(host, path, "HEAD");
    const get = await ask(host, path, "GET");
    expect(head.status, `HEAD ${host}${path}`).toBe(301);
    expect(head.location, `HEAD ${host}${path}`).toBe(`${APP}${path}`);
    expect(get.status, `GET ${host}${path}`).toBe(301);
    expect(get.location, `GET ${host}${path}`).toBe(`${APP}${path}`);
  });

  it.each(APEX_HOSTS)("%s: a path that contains a dot still redirects instead of being served here", async (host) => {
    // The matcher used to skip `.*\..*`, so these were answered on the apex host with 200 and no Location.
    for (const path of ["/tasks/a.b", "/logo-icon.svg"]) {
      const head = await ask(host, path, "HEAD");
      const get = await ask(host, path, "GET");
      expect(head.status, `HEAD ${host}${path}`).toBe(301);
      expect(head.location, `HEAD ${host}${path}`).toBe(`${APP}${path}`);
      expect(get.status, `GET ${host}${path}`).toBe(301);
      expect(get.location, `GET ${host}${path}`).toBe(`${APP}${path}`);
    }
  });

  it("the app host keeps its own answer, so an unrelated path is unaffected", async () => {
    for (const method of ["GET", "HEAD"] as const) {
      const root = await ask("app.sheethappensofficer.com", "/", method);
      expect(root.status, `${method} app /`).toBe(200);
      expect(root.location, `${method} app /`).toBeNull();

      // A public file still answers through the proxy: only the request header is added on the way past.
      const svg = await fetch(`${BASE}/logo-icon.svg`, {
        method,
        redirect: "manual",
        headers: { "x-forwarded-host": "app.sheethappensofficer.com" },
      });
      expect(svg.status, `${method} app /logo-icon.svg`).toBe(200);
      expect(svg.headers.get("location"), `${method} app /logo-icon.svg`).toBeNull();
      expect(svg.headers.get("content-type"), `${method} app /logo-icon.svg`).toContain("image/svg+xml");
    }
  });
});
