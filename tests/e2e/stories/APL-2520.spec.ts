// SHO-US-9.3 Production deployment and backups (APL-2520).
// What a browser can see is checked on staging: HTTPS, /api/health and /api/health/jobs.
// The droplet, the backup cluster and the owner's mailbox are not opened from here, and production is not requested.
// AC2, AC4, AC5 and AC7 read the repo (@static). AC6's source reads are separate @static tests.
// AC3 (restore drill) and AC8 (firewall and SSH) are @static and @manual.
// None of those is a live acceptance result. The staging run excludes both tags.
import { readFileSync } from "node:fs";
import { test, expect, BASE_URL } from "../support";

const base = BASE_URL;
const read = (path: string) => readFileSync(path, "utf8");

// One skip for the whole file. The password is SHO_QA_PASS and is never generated here.
test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");

test("AC1: the app is served over HTTPS and its health check passes", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin }) => {
  const host = new URL(base).hostname;
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!local) {
    expect(base.startsWith("https://"), base).toBe(true);
    expect(host.endsWith("sheethappensofficer.com"), host).toBe(true);
    expect(host === "sheethappensofficer.com" || host.startsWith("app."), host).toBe(false);
  }
  const r = await admin.page.request.get("/api/health");
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.ok).toBe(true);
  expect(typeof j.release === "string" && j.release.length >= 7, "the release (commit) is reported").toBe(true);
});

test("AC1: health answers 200 with ok true and nothing secret in the body", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin }) => {
  const r = await admin.page.request.get("/api/health");
  expect(r.status()).toBe(200);
  const text = await r.text();
  const j = JSON.parse(text) as { ok?: boolean };
  expect(j.ok).toBe(true);
  expect(Object.keys(JSON.parse(text)).sort()).toEqual(["ok", "release"]);
  expect(text.toLowerCase()).not.toMatch(/sk-ant-|anthropic_api_key|postgres:\/\//);
});

test("AC6: the jobs health page reports the check job's last run, and is not stale", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin }) => {
  const r = await admin.page.request.get("/api/health/jobs");
  expect(r.status(), "503 means the check job has not finished in 36 hours").toBe(200);
  const j = await r.json();
  expect(j.ok).toBe(true);
  if (j.lastCheck) expect(j.ageHours).toBeLessThan(36);
});

// @static: the stale window is in the source. The jobs page above is the live check.
test("AC6 source: the jobs health route treats 36 hours as stale", { tag: "@static", annotation: { type: "qa:TC", description: "missing" } }, () => {
  expect(read("src/app/api/health/jobs/route.ts")).toContain("const STALE_HOURS = 36");
});

test("AC6: the Super Admin can reach the notification bell (job notices land there)", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin }) => {
  const r = await admin.api.get("/api/notifications");
  expect(r.status).toBe(200);
  expect(Array.isArray(r.json.items)).toBe(true);
});

// @static: the job notice names are in the source. The bell above is the live check.
test("AC6 source: job failure and a missed job are notice kinds", { tag: "@static", annotation: { type: "qa:TC", description: "missing" } }, () => {
  const feed = read("src/lib/feed.ts");
  expect(feed).toContain("JOB_FAILED");
  expect(feed).toContain("JOB_MISSED");
});

// @static: the release script is not a failed deploy on staging.
test("AC2: a failed health check after a deploy restores the previous release and emails the owner", { tag: "@static", annotation: { type: "qa:TC", description: "missing" } }, () => {
  const release = read("deploy/release.sh");
  const deploy = read(".github/workflows/deploy.yml");
  expect(release).toContain("health check failed; rolling back");
  expect(release).toContain('switch "$PREV"');
  expect(release).toContain("sudo systemctl restart sho");
  expect(deploy).toContain("Email the owner if the release failed");
  expect(deploy).toContain("previous release was restored");
  expect(deploy).toContain("nakul.jain@aplyd.com");
  expect(read("README.md")).toContain("A failed health check");
  expect(read("README.md")).toContain("puts the previous release back");
});

// @static @manual: a restore drill is a step a person records. The workflow file is not that drill.
test("AC3: a backup restore into a test database was rehearsed and recorded", { tag: ["@static", "@manual"], annotation: { type: "qa:TC", description: "missing" } }, () => {
  const workflow = read(".github/workflows/restore-check.yml");
  const script = read("deploy/restore-check.cjs");
  expect(workflow).toContain("name: Restore check");
  expect(workflow).toContain("RESTORE_DATABASE_URL");
  expect(workflow).toContain("Read-only: counts rows in both databases");
  expect(script.length).toBeGreaterThan(0);
  expect(read("README.md")).toContain("Managed Postgres");
});

// @static: source and gitignore do not show the server logs.
test("AC4: no secret is committed or logged", { tag: "@static", annotation: { type: "qa:TC", description: "missing" } }, () => {
  const health = read("src/app/api/health/route.ts");
  const model = read("src/lib/model.ts");
  const deploy = read(".github/workflows/deploy.yml");
  expect(health).toContain("return Response.json({ ok: true, release:");
  expect(health).not.toContain("ANTHROPIC_API_KEY");
  expect(model).toContain("nothing here logs");
  expect(model).toContain("Never read the error body into a message");
  expect(deploy).toContain("A quote or line break in a concierge setting would break app.env");
  expect(read(".gitignore")).toMatch(/\.env/);
});

// @static: the mail template does not show which folder the message landed in.
test("AC5: a sign-up verification email reaches the inbox, not junk", { tag: "@static", annotation: { type: "qa:TC", description: "missing" } }, () => {
  const mail = read("src/lib/email.ts");
  const signup = read("src/app/api/auth/signup/route.ts");
  expect(mail).toContain('subject: "Verify your email for Sheet Happens Officer"');
  expect(mail).toContain("/verify?token=");
  expect(mail).not.toMatch(/junk|spam/i);
  expect(signup).toContain('status: "check_email"');
  expect(read("README.md")).toContain("confirm the verification email lands in the inbox, not junk");
});

// @static: the workflow text is not a five-minute outage on the live check.
test("AC7: the external uptime check emails the owner when /api/health fails for 5 minutes", { tag: "@static", annotation: { type: "qa:TC", description: "missing" } }, () => {
  const readme = read("README.md");
  const ops = read(".github/workflows/ops-checks.yml");
  expect(readme).toContain("Point an external uptime check at `https://app.sheethappensofficer.com/api/health`");
  expect(ops).toContain('curl -fsS "https://$APP_HOST/api/health"');
  expect(ops).toContain("/api/health/jobs");
  expect(read("src/app/api/health/route.ts")).toContain("external uptime check");
});

// @static @manual: firewall and SSH are checked on the droplet by a person. Cloud-init text is not that check.
test("AC8: only web and SSH are open, password SSH is off, the database accepts the droplet only", { tag: ["@static", "@manual"], annotation: { type: "qa:TC", description: "missing" } }, () => {
  const cloud = read("deploy/cloud-init.yaml");
  const ops = read(".github/workflows/ops-checks.yml");
  const readme = read("README.md");
  expect(cloud).toContain("ufw default deny incoming");
  expect(cloud).toContain("ufw allow OpenSSH");
  expect(cloud).toContain("ufw allow 80/tcp");
  expect(cloud).toContain("ufw allow 443/tcp");
  expect(ops).toContain("Permission denied (publickey)");
  expect(ops).toContain("for p in 3000 5432 25060 8080");
  expect(ops).toContain('ok "port $p is closed"');
  expect(readme).toContain("add the droplet as a trusted source");
  expect(readme).toMatch(/private\s+network/);
});
