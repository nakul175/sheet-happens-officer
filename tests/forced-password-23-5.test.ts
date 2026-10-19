// SHO-US-23.5: a Super-Admin-issued password must be changed at first sign-in (replaces decision D2 of SHO-E23).
// APL-2624 has no TC ids, so every describe and test title carries the literal token qa:TC missing.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { account, BASE, Client, OUTBOX, PW, superAdmin, type Account } from "./helpers";

const run = Date.now();
let n = 0;
const NEW_PW = "my-own-pass-7";

function signInMail(email: string) {
  const files = readdirSync(OUTBOX).sort();
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8"))).filter((m) => m.to === email);
  const details = mails.filter((m) => /Your Sheet Happens Officer account/.test(m.subject));
  const text = (details.at(-1)?.text ?? "") as string;
  return { text, password: text.match(/Password: (\S+)/)?.[1] ?? "", resetToken: (mails.at(-1)?.text as string)?.match(/token=([\w-]+)/)?.[1] ?? "" };
}

/** A person added by the Super Admin and signed in with the emailed password. */
async function added(sa: Account) {
  const tag = `${run}${n++}`;
  const email = `forced${tag}@aplyd.com`;
  const r = await sa.c.post("/api/team", { firstName: "Fern", lastName: `Forced${tag}`, email, role: "MEMBER" });
  expect(r.status).toBe(201);
  const pw = signInMail(email).password;
  const c = new Client();
  expect((await c.post("/api/auth/signin", { email, password: pw })).status).toBe(200);
  return { c, id: r.json.person.id as string, email, pw };
}

/** The server-rendered HTML of an app screen. */
async function screen(c: Client, p: string) {
  const res = await fetch(BASE + p, { headers: { cookie: c.cookie }, redirect: "manual" });
  return { status: res.status, html: await res.text() };
}

const blocked = (r: { status: number; json: { code?: string } | null }) => r.status === 403 && r.json?.code === "PASSWORD_CHANGE_REQUIRED";

describe("qa:TC missing 23.5 AC1 every screen is blocked until a new password is set", () => {
  it("qa:TC missing app screens show only the Set your own password screen, for Add person", async () => {
    const sa = await superAdmin();
    const p = await added(sa);
    for (const url of ["/", "/projects", "/team", "/profile", "/search"]) {
      const s = await screen(p.c, url);
      expect(s.status, url).toBe(200);
      expect(s.html, url).toContain("Set your own password");
      expect(s.html, url).toContain("Sign out");
      expect(s.html, url).not.toContain('aria-label="Main"'); // no navigation, no page behind it
      expect(s.html, url).not.toContain("Close this message"); // the old closable banner is gone (AC7)
    }
  });

  it("qa:TC missing also applies after Resend sign-in details", async () => {
    const sa = await superAdmin();
    const p = await added(sa);
    expect((await sa.c.post(`/api/team/${p.id}/resend`)).status).toBe(200);
    const c = new Client();
    expect((await c.post("/api/auth/signin", { email: p.email, password: signInMail(p.email).password })).status).toBe(200);
    expect((await screen(c, "/projects")).html).toContain("Set your own password");
    expect(blocked(await c.get("/api/projects"))).toBe(true);
  });
});

describe("qa:TC missing 23.5 AC2 a valid new password lets them through", () => {
  it("qa:TC missing clears the forced state, opens the asked-for page, and kills the emailed password", async () => {
    const sa = await superAdmin();
    const p = await added(sa);
    expect((await p.c.post("/api/profile/password", { current: p.pw, password: "short1", confirm: "short1" })).status).toBe(400); // normal rules apply
    const r = await p.c.post("/api/profile/password", { current: p.pw, password: NEW_PW, confirm: NEW_PW });
    expect(r.status).toBe(200);

    expect((await p.c.get("/api/auth/me")).json.user.mustChangePassword).toBe(false);
    expect((await p.c.get("/api/projects")).status).toBe(200);
    const s = await screen(p.c, "/projects"); // the same URL now renders the page, not the wall
    expect(s.html).not.toContain("Set your own password");
    expect(s.html).toContain('aria-label="Main"');

    expect((await new Client().post("/api/auth/signin", { email: p.email, password: p.pw })).status).toBe(401);
    const again = new Client();
    expect((await again.post("/api/auth/signin", { email: p.email, password: NEW_PW })).status).toBe(200);
    expect((await again.get("/api/projects")).status).toBe(200);
  });
});

describe("qa:TC missing 23.5 AC3 the emailed password cannot be kept", () => {
  it("qa:TC missing refuses a new password equal to the emailed one, with a clear message", async () => {
    const sa = await superAdmin();
    const p = await added(sa);
    const r = await p.c.post("/api/profile/password", { current: p.pw, password: p.pw, confirm: p.pw });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Choose a new password. It cannot be the one we emailed you.");
    expect((await p.c.get("/api/auth/me")).json.user.mustChangePassword).toBe(true);
    expect(blocked(await p.c.get("/api/projects"))).toBe(true);
  });
});

describe("qa:TC missing 23.5 AC4 the server refuses app APIs in the forced state", () => {
  it("qa:TC missing answers 403 PASSWORD_CHANGE_REQUIRED to every app API but change-password, sign-out and me", async () => {
    const sa = await superAdmin();
    const p = await added(sa);
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/projects"], ["POST", "/api/projects", { name: "Nope" }], ["GET", "/api/my-tasks"], ["GET", "/api/team"],
      ["GET", `/api/team/${p.id}`], ["GET", "/api/notifications"], ["POST", "/api/notifications/read-all", {}], ["GET", "/api/search?q=x"],
      ["PATCH", "/api/profile", { name: "X" }], ["GET", "/api/profile/density"], ["PUT", "/api/profile/density", { compact: true }],
      ["GET", "/api/profile/sessions"], ["POST", "/api/profile/sessions/sign-out-others", {}], ["POST", "/api/profile/start-guide", {}],
      ["GET", "/api/deals"], ["GET", "/api/orgs"], ["GET", "/api/leaders"], ["GET", "/api/review"], ["GET", "/api/concierge/state"],
      ["GET", "/api/quick-add?text=x"], ["GET", "/api/usage"], ["GET", "/api/audit"], ["POST", "/api/actions/bulk-undo", { ids: ["x"] }],
    ];
    for (const [method, url, body] of calls) {
      const r = await p.c.call(method, url, body);
      expect(blocked(r), `${method} ${url} -> ${r.status}`).toBe(true);
      expect(r.json.error).toBe("Set your own password first.");
    }
    const me = await p.c.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.json.user.mustChangePassword).toBe(true);
    expect((await p.c.post("/api/profile/password", { current: "wrong-pass-1", password: NEW_PW, confirm: NEW_PW })).status).toBe(400); // reachable
    expect((await p.c.post("/api/auth/signout")).status).toBe(204);
    expect((await p.c.get("/api/auth/me")).status).toBe(401);
  });

  it("qa:TC missing only change-password and me let a forced person through (every route checked)", () => {
    const root = path.join(__dirname, "../src/app/api");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith("route.ts"));
    const allowed = files.filter((f) => /allowTempPassword/.test(readFileSync(path.join(root, f), "utf8"))).map((f) => f.split(path.sep).join("/")).sort();
    expect(allowed).toEqual(["auth/me/route.ts", "profile/password/route.ts"]);
  });
});

describe("qa:TC missing 23.5 AC5 Resend puts the person back in the forced state", () => {
  it("qa:TC missing forces a change again after they had already set their own", async () => {
    const sa = await superAdmin();
    const p = await added(sa);
    expect((await p.c.post("/api/profile/password", { current: p.pw, password: NEW_PW, confirm: NEW_PW })).status).toBe(200);
    expect((await sa.c.post(`/api/team/${p.id}/resend`)).status).toBe(200);
    const second = signInMail(p.email).password;
    const c = new Client();
    expect((await c.post("/api/auth/signin", { email: p.email, password: second })).status).toBe(200);
    expect((await c.get("/api/auth/me")).json.user.mustChangePassword).toBe(true);
    expect(blocked(await c.get("/api/my-tasks"))).toBe(true);
    expect((await c.post("/api/profile/password", { current: second, password: second, confirm: second })).status).toBe(400);
    expect((await c.post("/api/profile/password", { current: second, password: "another-pass-8", confirm: "another-pass-8" })).status).toBe(200);
    expect((await c.get("/api/my-tasks")).status).toBe(200);
  });
});

describe("qa:TC missing 23.5 AC6 own or reset passwords are never forced", () => {
  it("qa:TC missing a person who signed up with their own password is not forced", async () => {
    const a = await account("ownpw");
    expect((await a.c.get("/api/auth/me")).json.user.mustChangePassword).toBe(false);
    expect((await a.c.get("/api/projects")).status).toBe(200);
    expect((await screen(a.c, "/")).html).not.toContain("Set your own password");
  });

  it("qa:TC missing a person who used Forgot password is not forced", async () => {
    const sa = await superAdmin();
    const p = await added(sa);
    expect((await new Client().post("/api/auth/forgot-password", { email: p.email })).status).toBe(200);
    const token = signInMail(p.email).resetToken;
    expect((await new Client().post("/api/auth/reset-password", { token, password: NEW_PW, confirm: NEW_PW })).status).toBe(200);
    const c = new Client();
    expect((await c.post("/api/auth/signin", { email: p.email, password: NEW_PW })).status).toBe(200);
    expect((await c.get("/api/auth/me")).json.user.mustChangePassword).toBe(false);
    expect((await c.get("/api/projects")).status).toBe(200);
  });
});

describe("qa:TC missing 23.5 AC7 the email matches", () => {
  it("qa:TC missing says the password is temporary and must be changed at sign-in, not that it stays valid", async () => {
    const sa = await superAdmin();
    const p = await added(sa);
    const text = signInMail(p.email).text;
    expect(text).not.toMatch(/stays valid/i);
    expect(text).toContain("This password is temporary. When you sign in, you will be asked to set your own password before you can do anything else.");
    expect((await sa.c.post(`/api/team/${p.id}/resend`)).status).toBe(200);
    expect(signInMail(p.email).text).not.toMatch(/stays valid/i);
  });
});

// AC8 (from APL-2715, closed as a duplicate): the sign-in answer itself says whether the password must be changed.
describe("qa:TC missing 23.5 AC8 sign-in returns mustChangePassword", () => {
  it("qa:TC missing AC8: true on the emailed password, then false once the person sets their own", async () => {
    const sa = await superAdmin();
    const p = await added(sa);
    const first = await new Client().post("/api/auth/signin", { email: p.email, password: p.pw });
    expect(first.status).toBe(200);
    expect(first.json.user.mustChangePassword).toBe(true);
    expect((await p.c.post("/api/profile/password", { current: p.pw, password: NEW_PW, confirm: NEW_PW })).status).toBe(200);
    const after = await new Client().post("/api/auth/signin", { email: p.email, password: NEW_PW });
    expect(after.status).toBe(200);
    expect(after.json.user.mustChangePassword).toBe(false);
  });

  it("qa:TC missing AC8: true again after Resend sign-in details", async () => {
    const sa = await superAdmin();
    const p = await added(sa);
    expect((await sa.c.post(`/api/team/${p.id}/resend`)).status).toBe(200);
    const s = await new Client().post("/api/auth/signin", { email: p.email, password: signInMail(p.email).password });
    expect(s.status).toBe(200);
    expect(s.json.user.mustChangePassword).toBe(true);
  });

  it("qa:TC missing AC8: false for a person who signed up with their own password", async () => {
    const own = await account("ownpw");
    const s = await new Client().post("/api/auth/signin", { email: own.email, password: PW });
    expect(s.status).toBe(200);
    expect(s.json.user.mustChangePassword).toBe(false);
  });
});
