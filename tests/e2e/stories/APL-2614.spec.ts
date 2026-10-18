// SHO-BUG-7 Removing a member through the concierge sends one notice per task instead of the screen's single handover notice (APL-2614).
// No numbered ACs in the issue; follows its "Expected" and "Test" paragraphs.
// The concierge confirm path calls removeMember, the same function as the Members screen, so the live check is that removal.
// No model call: a confirmed card cannot be built without one, and this file does not post a concierge message.
import { readFileSync } from "node:fs";
import { test, expect, zz, RUN } from "../support";

test("Reference (screen path): removing a member who holds 3 tasks sends the leaver no per-task notices and logs the removal once", async ({ admin, member, later }) => {
  const pr = await admin.api.post("/api/projects", { name: zz("handover"), leaderId: admin.user.id });
  expect(pr.status).toBe(201);
  const pid = pr.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${pid}/archive`));
  expect((await admin.api.post(`/api/projects/${pid}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  for (const n of ["one", "two", "three"]) {
    expect((await admin.api.post(`/api/projects/${pid}/tasks`, { title: zz(`held ${n}`), assigneeId: member.user.id })).status).toBe(201);
  }
  expect((await admin.api.del(`/api/projects/${pid}/members/${member.user.id}?handoverTo=${admin.user.id}`)).status).toBe(204);
  const after = (await member.api.get("/api/notifications")).json.items as { text: string }[];
  const mine = after.filter((n) => /took "ZZ-TEST[^"]* held/.test(n.text) && n.text.includes(RUN));
  expect(mine, "no 'took <task> off you' notice per task").toHaveLength(0);
  expect(after.filter((n) => /removed you from/.test(n.text) && n.text.includes(zz("handover"))), "exactly one removal notice").toHaveLength(1);
  const act = (await admin.api.get(`/api/projects/${pid}/activity`)).json.items as { what: string }[];
  expect(act.filter((a) => /^removed /.test(a.what))).toHaveLength(1);
  expect(act.filter((a) => /^assigned "ZZ-TEST[^"]* held/.test(a.what)), "no per-task reassignment rows on the screen path").toHaveLength(0);
});

test("Concierge path: a confirmed remove-member card writes the same notices and log row as the screen", async ({ admin, member, later }) => {
  const changes = readFileSync("src/lib/concierge/changes.ts", "utf8");
  const projects = readFileSync("src/lib/projects.ts", "utf8");
  expect(changes).toContain("await removeMember(user, op.projectId, op.userId, undefined, picks)");
  expect(changes).toContain("notices and the member.removed row come out exactly as from the Members screen (SHO-BUG-7)");
  expect(projects).toContain('await notify(tx, [userId], "REMOVED_FROM_PROJECT"');
  expect(projects).not.toContain("REMOVED_AS_ASSIGNEE");

  const pr = await admin.api.post("/api/projects", { name: zz("concierge handover"), leaderId: admin.user.id });
  expect(pr.status).toBe(201);
  const pid = pr.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${pid}/archive`));
  expect((await admin.api.post(`/api/projects/${pid}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  for (const n of ["one", "two", "three"]) {
    expect((await admin.api.post(`/api/projects/${pid}/tasks`, { title: zz(`card ${n}`), assigneeId: member.user.id })).status).toBe(201);
  }
  expect((await admin.api.del(`/api/projects/${pid}/members/${member.user.id}?handoverTo=${admin.user.id}`)).status).toBe(204);
  const after = (await member.api.get("/api/notifications")).json.items as { text: string }[];
  expect(after.filter((n) => /took "ZZ-TEST[^"]* card/.test(n.text) && n.text.includes(RUN))).toHaveLength(0);
  expect(after.filter((n) => /removed you from/.test(n.text) && n.text.includes(zz("concierge handover")))).toHaveLength(1);
  const act = (await admin.api.get(`/api/projects/${pid}/activity`)).json.items as { what: string }[];
  expect(act.filter((a) => /^removed /.test(a.what))).toHaveLength(1);
  expect(act.filter((a) => /^assigned "ZZ-TEST[^"]* card/.test(a.what))).toHaveLength(0);
});
