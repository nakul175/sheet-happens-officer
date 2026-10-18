// SHO-US-9.3 Production deployment and backups  (Linear APL-2520)
// Only what a browser can see is automated here: the health pages and HTTPS. Infrastructure criteria are skipped with the reason.
import { test, expect } from "../support";

const base = process.env.STAGING_URL ?? "https://staging.sheethappensofficer.com";

test("AC1: the app is served over HTTPS and its health check passes", async ({ admin }) => {
  test.skip(!base.startsWith("https://"), "HTTPS can only be checked against the real staging URL, not a local http server");
  const r = await admin.page.request.get("/api/health");
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.ok).toBe(true);
  expect(typeof j.release === "string" && j.release.length >= 7, "the release (commit) is reported").toBe(true);
});

test("AC1: health answers 200 with ok true and nothing secret in the body", async ({ admin }) => {
  const r = await admin.page.request.get("/api/health");
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.ok).toBe(true);
  expect(Object.keys(j).sort()).toEqual(["ok", "release"]);
});

test("AC6: the jobs health page reports the check job's last run, and is not stale", async ({ admin }) => {
  const r = await admin.page.request.get("/api/health/jobs");
  expect(r.status(), "503 means the check job has not finished in 36 hours").toBe(200);
  const j = await r.json();
  expect(j.ok).toBe(true);
  if (j.lastCheck) expect(j.ageHours).toBeLessThan(36);
});

test("AC6: the Super Admin can reach the notification bell (job notices land there)", async ({ admin }) => {
  const r = await admin.api.get("/api/notifications");
  expect(r.status).toBe(200);
  expect(Array.isArray(r.json.items)).toBe(true);
});

test.skip("AC2: a failed health check after a deploy restores the previous release and emails the owner", () => {
  // Reason: needs a deliberately failing deploy on the server. Drilled once on 18 October 2026 (Actions run 39097651564 failed at Release; the live site stayed healthy). The owner's email must be confirmed by the owner.
});
test.skip("AC3: a backup restore into a test database was rehearsed and recorded", () => {
  // Reason: GitHub Actions "Restore check" (run 39020909778). Not a browser check.
});
test.skip("AC4: no secret is committed or logged", () => {
  // Reason: needs repository history and server logs, not a browser. The history scan is recorded in the issue; logs were not audited.
});
test.skip("AC5: a sign-up verification email reaches the inbox, not junk", () => {
  // Reason: needs a real mailbox. The folder (Inbox or Junk) was not recorded when the owner checked it.
});
test.skip("AC7: the external uptime check emails the owner when /api/health fails for 5 minutes", () => {
  // Reason: needs the DigitalOcean uptime check to fire; and the second check on /api/health/jobs is an owner console step that is not done.
});
test.skip("AC8: only web and SSH are open, password SSH is off, the database accepts the droplet only", () => {
  // Reason: network-level. The 'Server checks' workflow passed 22 of 22 on 17 October; the database trusted-source setting is a console step.
});
