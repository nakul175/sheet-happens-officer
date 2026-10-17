// Bell, project Activity, Audit log and Profile (SHO-US-7.1, 6.3, 6.5, 1.6).
import { describe, expect, it } from "vitest";
import { Client, PW, account, admin, project, superAdmin, task } from "./helpers";

describe("notifications", () => {
  it("tells the assignee, not the actor, and marks read", async () => {
    const lead = await account("lead");
    const ed = await account("ed");
    const p = await project(lead, lead, [{ who: ed }]);
    await task(lead, p.id, { title: "Ship it", assigneeId: ed.id });
    const n = (await ed.c.get("/api/notifications")).json;
    expect(n.unread).toBeGreaterThan(0);
    const assigned = n.items.find((i: { text: string }) => /Ship it/.test(i.text));
    expect(assigned.text).toMatch(/Lead assigned you/);
    expect(assigned.href).toMatch(/^\/tasks\//);
    expect((await lead.c.get("/api/notifications")).json.items.some((i: { text: string }) => /Ship it/.test(i.text))).toBe(false);
    expect((await ed.c.post(`/api/notifications/${assigned.id}/read`)).status).toBe(204);
    expect((await ed.c.get("/api/notifications")).json.unread).toBe(n.unread - 1);
    expect((await lead.c.post(`/api/notifications/${assigned.id}/read`)).status).toBe(204); // someone else's: no effect
    expect((await ed.c.get("/api/notifications")).json.unread).toBe(n.unread - 1);
    await ed.c.post("/api/notifications/read-all");
    expect((await ed.c.get("/api/notifications")).json.unread).toBe(0);
  });
});

describe("activity log", () => {
  it("is for the Leader and Admins in full, and for Editors on their own tasks only", async () => {
    const lead = await account("lead");
    const ed = await account("ed");
    const p = await project(lead, lead, [{ who: ed }]);
    await task(ed, p.id, { title: "Logged" });
    const r = await lead.c.get(`/api/projects/${p.id}/activity`);
    expect(r.status).toBe(200);
    expect(r.json.items[0]).toMatchObject({ who: "Ed", via: "screen" });
    expect(r.json.items[0].what).toMatch(/added "Logged" to To do/); // SHO-US-14.14
    expect((await ed.c.get(`/api/projects/${p.id}/activity`)).status).toBe(200);
    const out = await account("out");
    expect((await out.c.get(`/api/projects/${p.id}/activity`)).status).toBe(404);
  });
});

describe("audit log", () => {
  it("is Super Admin only, filterable, with IP on sign-in events only", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa);
    expect((await ad.c.get("/api/audit")).status).toBe(404);
    const c = new Client();
    await fetch((process.env.TASKBOARD_URL ?? "http://localhost:3000") + "/api/auth/signin", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ email: ad.email, password: "wrong-pass-1" }),
    });
    void c;
    const all = (await sa.c.get("/api/audit")).json;
    expect(all.items.length).toBeGreaterThan(0);
    const fails = (await sa.c.get("/api/audit?event=SIGN_IN_FAILED")).json.items;
    expect(fails.every((i: { event: string }) => i.event === "SIGN_IN_FAILED")).toBe(true);
    expect(fails.some((i: { ip: string }) => i.ip === "203.0.113.9")).toBe(true);
    expect(all.items.filter((i: { event: string; ip: string | null }) => !/^SIGN_IN/.test(i.event) && i.ip).length).toBe(0);
    const day = new Date().toISOString().slice(0, 10);
    expect((await sa.c.get(`/api/audit?from=${day}&to=${day}`)).status).toBe(200);
    expect((await sa.c.get(`/api/audit?person=${ad.id}`)).json.items.every((i: { email: string }) => i.email === ad.email)).toBe(true);
  });
});

describe("profile", () => {
  it("renames, lists devices, changes the password and keeps only this session", async () => {
    const a = await account("prof");
    const other = new Client();
    expect((await other.post("/api/auth/signin", { email: a.email, password: PW })).status).toBe(200);
    expect((await a.c.patch("/api/profile", { name: "  New Name " })).json.name).toBe("New Name");
    const s = (await a.c.get("/api/profile/sessions")).json.sessions;
    expect(s).toHaveLength(2);
    expect(s.filter((x: { current: boolean }) => x.current)).toHaveLength(1);
    const bad = await a.c.post("/api/profile/password", { current: "nope-1234", password: "fresh-pass-1", confirm: "fresh-pass-1" });
    expect(bad.status).toBe(400);
    expect((await a.c.post("/api/profile/password", { current: PW, password: "fresh-pass-1", confirm: "fresh-pass-1" })).status).toBe(200);
    expect((await a.c.get("/api/auth/me")).status).toBe(200);
    expect((await other.get("/api/auth/me")).status).toBe(401);
    const third = new Client();
    await third.post("/api/auth/signin", { email: a.email, password: "fresh-pass-1" });
    expect((await a.c.post("/api/profile/sessions/sign-out-others")).json.signedOut).toBe(1);
    expect((await third.get("/api/auth/me")).status).toBe(401);
    expect((await a.c.get("/api/auth/me")).status).toBe(200);
  });
});
