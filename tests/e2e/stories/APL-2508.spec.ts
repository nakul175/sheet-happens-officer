import { archiveProject, removeMember } from "../helpers/migration-2731";
import { test } from "./qa";
// APL-2508 · SHO-US-7.3 Tell everyone on a task when it is deleted
// Acceptance criteria: AC1 recipients get title, deleter and Trash link; AC2 own delete gives no notice; AC3 one notice per person.
// Needs the optional plain Member account (SHO_MEMBER_EMAIL / SHO_MEMBER_PASS) for AC1 and AC3.
// Data: every project and task is named "ZZ-TEST ..."; projects are archived afterwards.
import { expect, zz, type Who } from "../support";

type N = { text: string; href: string };
const inbox = async (who: Who) => (await who.api.get("/api/notifications?limit=200")).json.items as N[];

async function proj(admin: Who, member: Who | null, label: string, later: (f: () => Promise<unknown>) => void) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const p = r.json.project.id as string;
  later(() => archiveProject(admin.api, p, admin.user.id));
  if (member) {
    expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
    later(() => removeMember(admin, p, member.user.id));
  }
  return p;
}
const mk = async (who: Who, p: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await who.api.post(`/api/projects/${p}/tasks`, { dueDate: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10), title, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
};

test("AC1: when an Editor deletes a task, the Leader is told at once with the title, the deleter's name and a link to Trash", async ({ admin, member, later }) => {
  const p = await proj(admin, member, "del-notice", later);
  const t = await mk(member, p, zz("gone"), { assigneeId: admin.user.id });
  expect((await member.api.del(`/api/tasks/${t}`)).status).toBe(204);
  const hit = (await inbox(admin)).find((n) => n.text.includes(`"${zz("gone")}"`));
  expect(hit, "the Leader was told").toBeTruthy();
  expect(hit!.text).toContain(`${member.user.name} moved`);
  expect(hit!.text).toContain("to Trash");
  expect(hit!.href).toBe(`/projects/${p}/trash`);
  expect((await inbox(member)).some((n) => n.text.includes(zz("gone")) && n.text.includes("to Trash"))).toBe(false); // not the deleter
});

test("AC2: deleting a task when nobody else is on it creates no notice", async ({ admin, later }) => {
  const p = await proj(admin, null, "del-alone", later);
  const t = await mk(admin, p, zz("solo gone"), { assigneeId: admin.user.id });
  expect((await admin.api.del(`/api/tasks/${t}`)).status).toBe(204);
  expect((await inbox(admin)).some((n) => n.text.includes(zz("solo gone")))).toBe(false);
});

test("AC3: a person who is both Leader and assignee gets one notice, not two", async ({ admin, member, later }) => {
  const p = await proj(admin, member, "del-once", later);
  const t = await mk(member, p, zz("once only"), { assigneeId: admin.user.id });
  expect((await member.api.del(`/api/tasks/${t}`)).status).toBe(204);
  expect((await inbox(admin)).filter((n) => n.text.includes(`"${zz("once only")}"`) && n.text.includes("to Trash"))).toHaveLength(1);
});
