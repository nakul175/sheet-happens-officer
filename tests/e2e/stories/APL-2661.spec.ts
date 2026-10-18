// APL-2661 · apex and www redirect to the app. Read-only HEAD requests (curl -I). No DNS or Caddy changes.
// These hosts are absolute URLs. BASE_URL stays on staging; production is not the app under test.
import { test, expect } from "@playwright/test";

const APP = "https://app.sheethappensofficer.com/";
const APEX = [
  "http://sheethappensofficer.com",
  "https://sheethappensofficer.com",
  "http://www.sheethappensofficer.com",
  "https://www.sheethappensofficer.com",
];

/** HEAD, without following a redirect. A bad https certificate rejects the call. */
async function head(url: string) {
  const res = await fetch(url, { method: "HEAD", redirect: "manual" });
  return {
    status: res.status,
    location: res.headers.get("location"),
    authenticate: res.headers.get("www-authenticate"),
  };
}

test("AC1: apex and www on http and https return 301 to the app, with a valid certificate", async () => {
  // APL-2725: HEAD is 405 today. GET is 301 to the app. The criterion asks for curl -I, which is HEAD.
  for (const url of APEX) {
    const res = await head(url);
    expect(res.status, `${url} (HEAD, as curl -I)`).toBe(301);
    expect(new URL(res.location ?? "", url).href, url).toBe(APP);
  }
});

test("AC2: app and staging answer as themselves", async () => {
  const app = await head("https://app.sheethappensofficer.com");
  expect(app.status).toBe(200);
  expect(app.location).toBeNull();
  const staging = await head("https://staging.sheethappensofficer.com");
  expect(staging.status).toBe(401);
  expect(staging.authenticate?.toLowerCase()).toContain("basic");
  expect(staging.location).toBeNull();
});
