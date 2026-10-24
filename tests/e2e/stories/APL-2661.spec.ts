// APL-2710. APL-2661: apex and www redirect to the app. Read-only GET/HEAD through the Playwright request fixture.
// maxRedirects: 0 so a 301 is observed, not followed. HTTPS errors are not ignored, so a bad certificate fails the call.
// No DNS or Caddy changes. Staging hostname: staging.sheethappensofficer.com (workflow allow-list and tests/e2e/base-url.ts).
import { expect, test } from "@playwright/test";

const APP = "https://app.sheethappensofficer.com/";
const APEX = [
  "http://sheethappensofficer.com/",
  "https://sheethappensofficer.com/",
  "http://www.sheethappensofficer.com/",
  "https://www.sheethappensofficer.com/",
];

test.describe("APL-2661", { tag: "@APL-2661" }, () => {
  test("SHO-2725: apex and www HEAD requests return 301 to the app", { tag: "@readonly" }, async ({ request }) => {
    // GET succeeds on the forwarding service even while HEAD returns 405; neither substitutes for the other.
    for (const url of APEX) {
      const res = await request.head(url, { maxRedirects: 0 });
      expect.soft(res.status(), `${url} HEAD`).toBe(301);
      const location = res.headers()["location"] ?? "";
      expect.soft(new URL(location, url).href, `${url} HEAD Location: ${location}`).toBe(APP);
    }
  });

  test("AC1 apex and www over http and https return 301 to the app", { tag: "@readonly" }, async ({ request }) => {
    for (const url of APEX) {
      const res = await request.get(url, { maxRedirects: 0 });
      expect(res.status(), url).toBe(301);
      const location = res.headers()["location"] ?? "";
      expect(new URL(location, url).href, `${url} Location: ${location}`).toBe(APP);
    }
  });

  test("AC2 app and staging keep their own response instead of redirecting to the apex", { tag: "@readonly" }, async ({ request }) => {
    const app = await request.get("https://app.sheethappensofficer.com/", { maxRedirects: 0 });
    expect(app.status(), "app").toBe(200);
    expect(app.headers()["content-type"] ?? "", "app").toContain("text/html");
    expect(app.headers()["location"] ?? "", "app").toBe("");

    // Staging's own response is the Caddy basic-auth gate, not the apex and not a redirect.
    const staging = await request.get("https://staging.sheethappensofficer.com/", { maxRedirects: 0 });
    expect(staging.status(), "staging").toBe(401);
    expect((staging.headers()["www-authenticate"] ?? "").toLowerCase(), "staging").toContain("basic");
    expect(staging.headers()["location"] ?? "", "staging").toBe("");
  });
});
