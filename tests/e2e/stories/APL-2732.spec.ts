// APL-2732 story spec: a signed-in Member's browser asks to deactivate someone, and the answer is 403
// whatever the body, with no validation details. The Super Admin still gets today's 400 and can deactivate.
// Requests go from a real Chromium page (same origin, the browser's own session cookie).
// Production hosts are refused: point TASKBOARD_URL at a local server. workers=1.
// Throwaway people use ZZ-TEST names and nakul17+ aliases; afterAll deactivates them.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { account, BASE, PW, superAdmin, type Account } from "../../helpers";

const PRODUCTION_HOSTS = ["sheethappensofficer.com", "www.sheethappensofficer.com", "app.sheethappensofficer.com", "168.144.144.69"];
if (PRODUCTION_HOSTS.includes(new URL(BASE).hostname)) throw new Error(`Refusing to run against ${BASE}: production.`);

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const FORBIDDEN = { error: "You cannot deactivate this person." };
let seq = 0;
const people: Account[] = [];

function chromePath() {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome/Chromium binary. Set PW_CHROMIUM.");
}

async function zz(role: string) {
  const who = await account(`ZZ-TEST ${role} ${RUN}`, `nakul17+zz-2732s-${RUN}-${role.toLowerCase()}-${seq++}@aplyd.com`);
  people.push(who);
  return who;
}

/** A browser page signed in as `who`, through the same sign-in endpoint the sign-in screen uses. */
async function signedIn(who: Account) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const r = await ctx.request.post("/api/auth/signin", { data: { email: who.email, password: PW } });
  expect(r.status()).toBe(200);
  const page = await ctx.newPage();
  await page.goto("/");
  return page;
}

/** POSTs the raw text from inside the page, so a malformed body reaches the server unchanged. */
const post = (page: Page, path: string, body: string) =>
  page.evaluate(async ([p, b]) => {
    const res = await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: b });
    return { status: res.status, text: await res.text() };
  }, [path, body] as const);

let browser: Browser;
let sa: Account;
let memberB: Account;
let memberPage: Page;
let adminPage: Page;

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  sa = await superAdmin();
  const memberA = await zz("MemberA");
  memberB = await zz("MemberB");
  memberPage = await signedIn(memberA);
  adminPage = await signedIn(sa);
});

afterAll(async () => {
  await browser?.close();
  for (const who of people) {
    const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
    expect([200, 409]).toContain(off.status);
  }
});

describe("qa:TC missing APL-2732 story: Member deactivate from the browser is refused before the body is read", () => {
  for (const [label, body] of [["{}", "{}"], ["malformed \"{\"", "{"]] as const) {
    it(`qa:TC missing AC1: Member sends ${label} and gets 403 with no validation details`, async () => {
      const r = await post(memberPage, `/api/team/${memberB.id}/deactivate`, body);
      expect(r.status).toBe(403);
      expect(JSON.parse(r.text)).toEqual(FORBIDDEN);
      for (const leak of ["Validation failed", "issues", "reassign", "MEMBER", "ADMIN", "SUPER_ADMIN"]) expect(r.text).not.toContain(leak);
    });
  }

  it("qa:TC missing AC2: Super Admin sends {} and still gets today's 400 validation body", async () => {
    const r = await post(adminPage, `/api/team/${memberB.id}/deactivate`, "{}");
    expect(r.status).toBe(400);
    const json = JSON.parse(r.text);
    expect(json.error).toBe("Validation failed");
    expect(json.issues).toEqual([expect.objectContaining({ path: ["reassign"] })]);
  });

  it("qa:TC missing AC3: Member's valid body is still 403, and the Super Admin's valid deactivate succeeds", async () => {
    const valid = JSON.stringify({ reassign: "leaders" });
    const refused = await post(memberPage, `/api/team/${memberB.id}/deactivate`, valid);
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.text)).toEqual(FORBIDDEN);
    const done = await post(adminPage, `/api/team/${memberB.id}/deactivate`, valid);
    expect(done.status).toBe(200);
    expect(JSON.parse(done.text)).toEqual({ moved: 0, fellBack: [] });
  });
});
