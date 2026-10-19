// SHO-US-15.1 to 15.4: two sign-up domains, Super Admin adds a person, sign-in details by email, person profile.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { account, admin, Client, OUTBOX, project, PW, superAdmin, task } from "./helpers";

const run = Date.now();
let n = 0;

/** The newest sign-in-details mail sent to an address, with the password read out of it. */
function signInMail(email: string) {
  const files = readdirSync(OUTBOX).sort();
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8"))).filter((m) => m.to === email && /Your Sheet Happens Officer account/.test(m.subject));
  const text = (mails.at(-1)?.text ?? "") as string;
  return { count: mails.length, text, password: text.match(/Password: (\S+)/)?.[1] ?? "" };
}

const person = (domain = "aplyd.com") => {
  const tag = `${run}${n++}`;
  return { firstName: "Asha", lastName: `Verma${tag}`, email: `asha${tag}@${domain}`, role: "MEMBER" as const };
};

describe("15.1 two sign-up domains", () => {
  it("accepts both domains and refuses look-alikes", async () => {
    const c = new Client();
    const ok = await c.post("/api/auth/signup", { name: "Ath", email: `ath${run}@athenainfonomics.com`, password: PW });
    expect(ok.status).toBe(201);
    for (const bad of [`x${run}@mail.aplyd.com`, `x${run}@athenainfonomics.com.evil.com`, `x${run}@gmail.com`, `x${run}@aplyd.co`]) {
      const r = await c.post("/api/auth/signup", { name: "X", email: bad, password: PW });
      expect(r.status, bad).toBe(400);
    }
    const msg = await c.post("/api/auth/signup", { name: "X", email: `x${run}@gmail.com`, password: PW });
    expect(JSON.stringify(msg.json)).toContain("@athenainfonomics.com");
  });

  it("keeps sign-in generic for a wrong domain", async () => {
    const r = await new Client().post("/api/auth/signin", { email: `nobody${run}@gmail.com`, password: PW });
    expect(r.status).toBe(401);
  });
});

describe("15.2 Super Admin adds a person", () => {
  it("only the Super Admin can add; Admin and Member get 403", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa);
    const mem = await account("member");
    expect((await ad.c.post("/api/team", person())).status).toBe(403);
    expect((await mem.c.post("/api/team", person())).status).toBe(403);
    expect((await new Client().post("/api/team", person())).status).toBe(401);
  });

  it("creates an active account, emails a password that works, and flags it as temporary", async () => {
    const sa = await superAdmin();
    const p = person("athenainfonomics.com");
    const r = await sa.c.post("/api/team", p);
    expect(r.status).toBe(201);
    expect(r.json.person.name).toBe(`Asha ${p.lastName}`);
    expect(r.json.person.emailSent).toBe(true);
    expect(JSON.stringify(r.json)).not.toMatch(/password/i);

    const mail = signInMail(p.email);
    expect(mail.count).toBe(1);
    expect(mail.password).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(mail.text).toContain(`Username: ${p.email}`);

    const c = new Client();
    const s = await c.post("/api/auth/signin", { email: p.email, password: mail.password });
    expect(s.status).toBe(200);
    expect(s.json.user.orgRole).toBe("MEMBER");
    const list = (await sa.c.get("/api/team")).json.people as { email: string; status: string }[];
    expect(list.find((x) => x.email === p.email)?.status).toBe("ACTIVE");
  });

  it("allows any email domain (decision D1) and the Admin role", async () => {
    const sa = await superAdmin();
    const p = { ...person("gmail.com"), role: "ADMIN" as const };
    expect((await sa.c.post("/api/team", p)).status).toBe(201);
    const s = await new Client().post("/api/auth/signin", { email: p.email, password: signInMail(p.email).password });
    expect(s.status).toBe(200);
    expect(s.json.user.orgRole).toBe("ADMIN");
  });

  it("refuses Super Admin as a role, bad input and duplicates", async () => {
    const sa = await superAdmin();
    expect((await sa.c.post("/api/team", { ...person(), role: "SUPER_ADMIN" })).status).toBe(400);
    expect((await sa.c.post("/api/team", { ...person(), firstName: " " })).status).toBe(400);
    expect((await sa.c.post("/api/team", { ...person(), email: "not-an-email" })).status).toBe(400);
    const p = person();
    expect((await sa.c.post("/api/team", p)).status).toBe(201);
    const dup = await sa.c.post("/api/team", p);
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatch(/already exists/);
  });

  it("tells the Super Admin when the person is deactivated", async () => {
    const sa = await superAdmin();
    const p = person();
    const id = (await sa.c.post("/api/team", p)).json.person.id as string;
    expect((await sa.c.post(`/api/team/${id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    const dup = await sa.c.post("/api/team", p);
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatch(/deactivated/);
  });

  it("writes the audit log without the password", async () => {
    const sa = await superAdmin();
    const p = person();
    await sa.c.post("/api/team", p);
    const pw = signInMail(p.email).password;
    const log = JSON.stringify((await sa.c.get("/api/audit")).json);
    expect(log).toContain("USER_ADDED_BY_ADMIN");
    expect(log).not.toContain(pw);
  });
});

describe("15.3 sign-in details", () => {
  it("resend makes a new password, kills the old one and signs the person out", async () => {
    const sa = await superAdmin();
    const p = person();
    const id = (await sa.c.post("/api/team", p)).json.person.id as string;
    const first = signInMail(p.email).password;
    const c = new Client();
    expect((await c.post("/api/auth/signin", { email: p.email, password: first })).status).toBe(200);

    const r = await sa.c.post(`/api/team/${id}/resend`);
    expect(r.status).toBe(200);
    expect(r.json.emailSent).toBe(true);
    const second = signInMail(p.email);
    expect(second.count).toBe(2);
    expect(second.password).not.toBe(first);
    expect((await c.get("/api/auth/me")).status).toBe(401); // old session is gone
    expect((await new Client().post("/api/auth/signin", { email: p.email, password: first })).status).toBe(401);
    expect((await new Client().post("/api/auth/signin", { email: p.email, password: second.password })).status).toBe(200);
  });

  it("only the Super Admin can resend, and not to themselves", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa);
    const mem = await account("member");
    expect((await ad.c.post(`/api/team/${mem.id}/resend`)).status).toBe(403);
    expect((await mem.c.post(`/api/team/${ad.id}/resend`)).status).toBe(403);
    expect((await sa.c.post(`/api/team/${sa.id}/resend`)).status).toBe(409);
    expect((await sa.c.post(`/api/team/nope/resend`)).status).toBe(404);
  });

  it("qa:TC missing the emailed password signs in until the person sets their own (SHO-US-23.5 then forces the change)", async () => {
    const sa = await superAdmin();
    const p = person();
    await sa.c.post("/api/team", p);
    const pw = signInMail(p.email).password;
    const c = new Client();
    for (let i = 0; i < 2; i++) expect((await new Client().post("/api/auth/signin", { email: p.email, password: pw })).status).toBe(200);
    await c.post("/api/auth/signin", { email: p.email, password: pw });
    const changed = await c.post("/api/profile/password", { current: pw, password: "my-own-pass-7", confirm: "my-own-pass-7" });
    expect(changed.status).toBe(200);
    expect((await new Client().post("/api/auth/signin", { email: p.email, password: pw })).status).toBe(401);
    expect((await new Client().post("/api/auth/signin", { email: p.email, password: "my-own-pass-7" })).status).toBe(200);
  });
});

describe("15.4 person profile", () => {
  it("a Member sees a name and shared projects only", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const a = await account("amy");
    const b = await account("bob");
    const shared = await project(sa, lead, [{ who: a }, { who: b }]);
    const other = await project(sa, lead, [{ who: b }]);
    const r = await a.c.get(`/api/team/${b.id}`);
    expect(r.status).toBe(200);
    const pr = r.json.person;
    expect(Object.keys(pr).sort()).toEqual(["id", "name", "projects"]);
    expect(pr.projects.map((x: { id: string }) => x.id)).toEqual([shared.id]);
    expect(JSON.stringify(pr)).not.toContain(other.id);
    expect(JSON.stringify(pr)).not.toContain(b.email);
  });

  it("an Admin sees email, role, status, joined date, every project and open tasks", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa);
    const lead = await account("lead");
    const b = await account("bob");
    const p1 = await project(sa, lead, [{ who: b }]);
    await task(lead, p1.id, { title: "Ping", assigneeId: b.id });
    const r = await ad.c.get(`/api/team/${b.id}`);
    expect(r.status).toBe(200);
    const pr = r.json.person;
    expect(pr.email).toBe(b.email);
    expect(pr.orgRole).toBe("MEMBER");
    expect(pr.status).toBe("ACTIVE");
    expect(typeof pr.joinedAt).toBe("string");
    expect(pr.projects.find((x: { id: string }) => x.id === p1.id)).toMatchObject({ role: "EDITOR", openTasks: 1 });
    expect(pr.openTasks).toBeGreaterThanOrEqual(1);
  });

  it("a deactivated or unknown person is not found for a Member, but visible to an Admin", async () => {
    const sa = await superAdmin();
    const mem = await account("member");
    const gone = await account("gone");
    expect((await sa.c.post(`/api/team/${gone.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    expect((await mem.c.get(`/api/team/${gone.id}`)).status).toBe(404);
    expect((await mem.c.get(`/api/team/nope`)).status).toBe(404);
    const r = await sa.c.get(`/api/team/${gone.id}`);
    expect(r.status).toBe(200);
    expect(r.json.person.status).toBe("DEACTIVATED");
  });

  it("needs a sign-in", async () => {
    expect((await new Client().get("/api/team/anything")).status).toBe(401);
  });
});
