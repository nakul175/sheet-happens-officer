// Integration tests for reminders (7.4), search (3.2/3.6 AC6), Usage (9.2 AC3) and sign-out everywhere (1.6 AC3).
// Server must run with SUPER_ADMIN_EMAILS=root.test@aplyd.com, JOB_SECRET set and the same EMAIL_OUTBOX_DIR.
import { describe, expect, it } from "vitest";
import { Client, PW, account, istDate, project, superAdmin, task } from "./helpers";

const SECRET = process.env.JOB_SECRET ?? "";
const runJob = (name: string) => fetch(`${process.env.TASKBOARD_URL ?? "http://localhost:3000"}/api/jobs/${name}`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
const texts = async (a: { c: Client }) => ((await a.c.get("/api/notifications")).json.items as { text: string }[]).map((i) => i.text);

describe("reminders (7.4)", () => {
  it.skipIf(!SECRET)("reminds the holder once per day on the right days, and skips done, blocked and very old tasks", async () => {
    const lead = await account("lead");
    const w = await account("worker");
    const p = await project(lead, lead, [{ who: w }]);
    const mk = (title: string, due: string | undefined) => task(lead, p.id, { title, assigneeId: w.id, ...(due ? { dueDate: due } : {}) });
    await mk("R-tomorrow", istDate(1));
    await mk("R-today", istDate(0));
    await mk("R-late1", istDate(-1));
    await mk("R-late8", istDate(-8));
    await mk("R-late2", istDate(-2));
    await mk("R-late29", istDate(-29));
    await mk("R-nodate", undefined);
    const done = await mk("R-done", istDate(1));
    const blocked = await mk("R-blocked", istDate(1));
    expect((await w.c.post(`/api/tasks/${done}/complete`)).status).toBe(200);
    expect((await lead.c.patch(`/api/tasks/${blocked}`, { blocked: true })).status).toBe(200);
    expect((await runJob("reminders")).status).toBe(200);
    expect((await runJob("reminders")).status).toBe(200); // same day: no second reminder
    const t = await texts(w);
    const has = (s: string) => t.filter((x) => x.includes(`"${s}"`) && / is (due|overdue)/.test(x));
    expect(has("R-tomorrow")).toEqual(['"R-tomorrow" is due tomorrow.']);
    expect(has("R-today")).toEqual(['"R-today" is due today.']);
    expect(has("R-late1")).toEqual(['"R-late1" is overdue by 1 day.']);
    expect(has("R-late8")).toEqual(['"R-late8" is overdue by 8 days.']);
    for (const none of ["R-late2", "R-late29", "R-nodate", "R-done", "R-blocked"]) expect(has(none)).toHaveLength(0);
    expect(await texts(lead)).not.toContain('"R-tomorrow" is due tomorrow.');
  });

  it.skipIf(!SECRET)("reminds the approver, not the assignee, while a task awaits approval", async () => {
    const lead = await account("lead");
    const w = await account("worker");
    const boss = await account("approver");
    const p = await project(lead, lead, [{ who: w }, { who: boss }]);
    const t = await task(lead, p.id, { title: "R-approval", assigneeId: w.id, dueDate: istDate(1) });
    expect((await lead.c.put(`/api/tasks/${t}/approver`, { approverId: boss.id })).status).toBe(200);
    expect((await w.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
    await runJob("reminders");
    expect((await texts(boss)).filter((x) => x.includes("R-approval") && x.includes("is due tomorrow"))).toHaveLength(1);
    expect((await texts(w)).filter((x) => x.includes("R-approval") && x.includes("is due tomorrow"))).toHaveLength(0);
  });

  it("the jobs endpoints refuse callers without the secret", async () => {
    expect((await new Client().post("/api/jobs/reminders")).status).toBe(401);
  });
});

describe("cron health", () => {
  it("answers on /api/health/jobs", async () => {
    const r = await new Client().get("/api/health/jobs");
    expect([200, 503]).toContain(r.status);
    expect(typeof r.json.ok).toBe("boolean");
  });
});

describe("search (3.2 AC6, 3.6 AC6)", () => {
  it("finds only what the person may see, leaves archived out unless asked, and shows Admins everything", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const me = await account("me");
    const out = await account("outsider");
    const tag = `zq${Date.now()}`;
    const mine = await project(lead, lead, [{ who: me }]);
    const secret = await project(lead, lead);
    const old = await project(lead, lead, [{ who: me }]);
    const a = await task(lead, mine.id, { title: `${tag} visible`, assigneeId: me.id });
    await task(lead, secret.id, { title: `${tag} hidden` });
    await task(lead, old.id, { title: `${tag} archived task`, assigneeId: me.id });
    expect((await lead.c.post(`/api/projects/${old.id}/archive`)).status).toBe(200);
    const q = (who: { c: Client }, extra = "") => who.c.get(`/api/search?q=${tag}${extra}`);
    const mine1 = (await q(me)).json.tasks.map((t: { title: string }) => t.title).sort();
    expect(mine1).toEqual([`${tag} visible`]);
    const withArch = (await q(me, "&archived=true")).json.tasks.map((t: { title: string }) => t.title).sort();
    expect(withArch).toEqual([`${tag} archived task`, `${tag} visible`]);
    expect((await q(out, "&archived=true")).json.tasks).toHaveLength(0);
    expect((await q(sa)).json.tasks.map((t: { title: string }) => t.title).sort()).toEqual([`${tag} hidden`, `${tag} visible`]);
    expect((await me.c.get("/api/search?q=z")).json.tasks).toHaveLength(0); // too short
    expect((await new Client().get(`/api/search?q=${tag}`)).status).toBe(401);
    expect(a).toBeTruthy();
  });
});

describe("usage (9.2 AC3)", () => {
  it("is visible to the Super Admin only", async () => {
    const sa = await superAdmin();
    const m = await account("member");
    const r = await sa.c.get("/api/usage");
    expect(r.status).toBe(200);
    expect(r.json.month.calls).toBeGreaterThanOrEqual(0);
    expect((await m.c.get("/api/usage")).status).toBe(404);
  });
});

describe("sign out everywhere (1.6 AC3)", () => {
  it("ends this session and every other one", async () => {
    const a = await account("dev");
    const other = new Client();
    expect((await other.post("/api/auth/signin", { email: a.email, password: PW })).status).toBe(200);
    expect((await a.c.get("/api/auth/me")).status).toBe(200);
    expect((await a.c.post("/api/profile/sessions/sign-out-all")).status).toBe(200);
    expect((await a.c.get("/api/auth/me")).status).toBe(401);
    expect((await other.get("/api/auth/me")).status).toBe(401);
  });
});

describe("deactivation (2.4 AC2/AC4)", () => {
  it("tells which Leaders took the tasks and lists the projects a leaver leads", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const friend = await account("friend");
    const leaver = await account("leaver");
    const p = await project(lead, lead, [{ who: leaver }]);
    await task(leaver, p.id);
    const r = await sa.c.post(`/api/team/${leaver.id}/deactivate`, { reassign: friend.id });
    expect(r.status).toBe(200);
    expect(r.json.moved).toBe(1);
    expect(r.json.fellBack).toEqual([expect.any(String)]);
    const blocked = await sa.c.post(`/api/team/${lead.id}/deactivate`, { reassign: "leaders" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.leads.map((l: { id: string }) => l.id)).toContain(p.id);
  });
});
