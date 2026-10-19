// APL-2715: a Super-Admin-issued password is temporary and must be replaced at first sign-in.
// No TC id is written on the issue, so each title carries the literal token qa:TC missing.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { signInDetailsMail } from "@/lib/email";
import { Client, OUTBOX, PW, superAdmin } from "./helpers";

const run = Date.now().toString(36);
let n = 0;
const REFUSED = "Choose a new password. It cannot be the one we emailed you.";
const BLOCKED = ["/api/projects", "/api/my-tasks", "/api/team", "/api/notifications", "/api/search?q=a"];

function signInMail(email: string) {
  const files = readdirSync(OUTBOX).sort();
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8"))).filter((m) => m.to === email && /Your Sheet Happens Officer account/.test(m.subject));
  const text = (mails.at(-1)?.text ?? "") as string;
  return { count: mails.length, text, password: text.match(/Password: (\S+)/)?.[1] ?? "" };
}

function resetToken(email: string) {
  const files = readdirSync(OUTBOX).sort();
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8"))).filter((m) => m.to === email && /Reset your Sheet Happens Officer password/.test(m.subject));
  return (mails.at(-1)?.text as string | undefined)?.match(/token=([\w-]+)/)?.[1] ?? "";
}

function person() {
  const tag = `${run}${n++}`;
  return { firstName: "ZZ-TEST", lastName: `Wall${tag}`, email: `nakul17+apl2715-${tag}@aplyd.com`, role: "MEMBER" as const };
}

async function issued() {
  const sa = await superAdmin();
  const p = person();
  const created = await sa.c.post("/api/team", p);
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const password = signInMail(p.email).password;
  expect(password, "emailed temporary password").toMatch(/^[A-Za-z0-9]{12}$/);
  return { sa, p, id: created.json.person.id as string, password };
}

async function signedIn(email: string, password: string) {
  const c = new Client();
  const s = await c.post("/api/auth/signin", { email, password });
  return { c, s };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("APL-2715 temporary password", () => {
  it("sign-in returns mustChangePassword and app screens stay blocked qa:TC missing", async () => {
    const { p, password } = await issued();
    const { c, s } = await signedIn(p.email, password);
    expect(s.status).toBe(200);
    expect(s.json.user.mustChangePassword).toBe(true);
    const me = await c.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.json.user.mustChangePassword).toBe(true);
    for (const route of BLOCKED) {
      const r = await c.get(route);
      expect(r.status, route).toBe(403);
      expect(r.json, route).toMatchObject({ error: "Set your own password first.", code: "PASSWORD_CHANGE_REQUIRED" });
    }
  });

  it("a valid new password clears the forced state and the emailed password stops working qa:TC missing", async () => {
    const { p, password } = await issued();
    const { c } = await signedIn(p.email, password);
    const changed = await c.post("/api/profile/password", { current: password, password: "my-own-pass-7", confirm: "my-own-pass-7" });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    const me = await c.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.json.user.mustChangePassword).toBe(false);
    expect((await c.get("/api/projects")).status).toBe(200);
    expect((await new Client().post("/api/auth/signin", { email: p.email, password })).status).toBe(401);
    const again = await new Client().post("/api/auth/signin", { email: p.email, password: "my-own-pass-7" });
    expect(again.status).toBe(200);
    expect(again.json.user.mustChangePassword).toBe(false);
    const feed = readFileSync("src/lib/feed.ts", "utf8");
    expect(feed).toContain("PASSWORD_CHANGE_REQUIRED");
    expect(feed).toContain("tempPasswordAt: null");
  });

  it("a new password equal to the emailed one is refused qa:TC missing", async () => {
    const { p, password } = await issued();
    const { c } = await signedIn(p.email, password);
    const same = await c.post("/api/profile/password", { current: password, password, confirm: password });
    expect(same.status).toBe(400);
    expect(same.json.error).toBe(REFUSED);
    expect((await c.get("/api/auth/me")).json.user.mustChangePassword).toBe(true);
    expect((await c.get("/api/projects")).status).toBe(403);
    const src = readFileSync("src/lib/feed.ts", "utf8");
    expect(src).toContain(REFUSED);
  });

  it("app APIs other than change-password, sign-out and me answer 403 PASSWORD_CHANGE_REQUIRED qa:TC missing", async () => {
    const { p, password } = await issued();
    const { c } = await signedIn(p.email, password);
    const created = await c.post("/api/projects", {});
    expect(created.status).toBe(403);
    expect(created.json.code).toBe("PASSWORD_CHANGE_REQUIRED");
    const renamed = await c.patch("/api/profile", { name: "ZZ-TEST Renamed" });
    expect(renamed.status).toBe(403);
    expect(renamed.json.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await c.get("/api/auth/me")).status).toBe(200);
    const out = await c.post("/api/auth/signout");
    expect(out.status).toBe(204);
    expect((await c.get("/api/auth/me")).status).toBe(401);

    const allow = walk("src")
      .filter((file) => readFileSync(file, "utf8").includes("allowTempPassword: true"))
      .map((file) => file.split(path.sep).join("/"))
      .sort();
    expect(allow).toEqual([
      "src/app/(app)/layout.tsx",
      "src/app/api/auth/me/route.ts",
      "src/app/api/profile/password/route.ts",
    ]);
    const gate = ["src/lib/http.ts", "src/lib/auth.ts", "src/app/api/profile/password/route.ts"].map((file) => readFileSync(file, "utf8")).join("\n");
    expect(gate).toContain("PASSWORD_CHANGE_REQUIRED");
    expect(readFileSync("src/app/api/auth/signout/route.ts", "utf8")).not.toContain("currentUser");
  });

  it("resend sign-in details forces the new password to be changed qa:TC missing", async () => {
    const { sa, p, id, password } = await issued();
    const first = await signedIn(p.email, password);
    expect(first.s.json.user.mustChangePassword).toBe(true);
    const resent = await sa.c.post(`/api/team/${id}/resend`);
    expect(resent.status).toBe(200);
    const second = signInMail(p.email);
    expect(second.count).toBe(2);
    expect(second.password).not.toBe(password);
    expect((await first.c.get("/api/auth/me")).status).toBe(401);
    expect((await new Client().post("/api/auth/signin", { email: p.email, password })).status).toBe(401);
    const { c, s } = await signedIn(p.email, second.password);
    expect(s.status).toBe(200);
    expect(s.json.user.mustChangePassword).toBe(true);
    expect((await c.get("/api/projects")).json.code).toBe("PASSWORD_CHANGE_REQUIRED");
    const team = readFileSync("src/lib/team.ts", "utf8");
    const resend = team.slice(team.indexOf("export async function resendSignIn"));
    expect(resend).toContain("tempPasswordAt: now");
    expect(resend).toContain("PASSWORD_CHANGE_REQUIRED");
  });

  it("a person who set their own password is not forced qa:TC missing", async () => {
    const sa = await superAdmin();
    const me = await sa.c.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.json.user.mustChangePassword).toBe(false);
    const sign = await new Client().post("/api/auth/signin", { email: sa.email, password: PW });
    expect(sign.status).toBe(200);
    expect(sign.json.user.mustChangePassword).toBe(false);
    for (const route of ["/api/projects", "/api/my-tasks", "/api/team"]) {
      expect((await sa.c.get(route)).status, route).toBe(200);
    }
  });

  it("a person who used forgot password is not forced qa:TC missing", async () => {
    const { p, password } = await issued();
    const forced = await signedIn(p.email, password);
    expect(forced.s.json.user.mustChangePassword).toBe(true);
    const asked = await new Client().post("/api/auth/forgot-password", { email: p.email });
    expect(asked.status).toBe(200);
    const token = resetToken(p.email);
    expect(token).toBeTruthy();
    const reset = await new Client().post("/api/auth/reset-password", { token, password: "reset-pass-7", confirm: "reset-pass-7" });
    expect(reset.status, JSON.stringify(reset.json)).toBe(200);
    expect((await forced.c.get("/api/auth/me")).status).toBe(401);
    const { c, s } = await signedIn(p.email, "reset-pass-7");
    expect(s.status).toBe(200);
    expect(s.json.user.mustChangePassword).toBe(false);
    expect((await c.get("/api/projects")).status).toBe(200);
    expect((await new Client().post("/api/auth/signin", { email: p.email, password })).status).toBe(401);
    const src = readFileSync("src/app/api/auth/reset-password/route.ts", "utf8");
    expect(src).toContain("tempPasswordAt: null");
    expect(src).not.toContain("PASSWORD_CHANGE_REQUIRED");
  });

  it("the add-person copy and the sign-in email say the password is temporary qa:TC missing", async () => {
    const mail = signInDetailsMail("nakul17+apl2715-copy@aplyd.com", "ZZ-TEST", "A Super Admin", "TempPass1234");
    expect(mail.text.toLowerCase()).toContain("temporary");
    expect(mail.text).not.toContain("stays valid");
    const team = readFileSync("src/app/(app)/team/Team.tsx", "utf8");
    expect(team).toContain("The person must replace it with their own when they first sign in.");
    expect(team).not.toContain("stays valid until the person changes it");
    const shell = readFileSync("src/app/(app)/Shell.tsx", "utf8");
    expect(shell).not.toContain("The emailed one still works until you do.");
    expect(shell).not.toContain("function SetPasswordBar");
  });
});
