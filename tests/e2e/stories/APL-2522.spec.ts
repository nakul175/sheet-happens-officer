// APL-2522 story spec for the edge cases tracked by APL-2660.
// workers=1: the cases in this file run one after another, and the suite runs one file at a time.
// Production hosts are refused. Point TASKBOARD_URL at a local server, never at production.
// Vitest rewrites the live BASE_URL to "/", so the guard reads the value from process start.
// Thrown-away people and projects use ZZ-TEST names and nakul17+ aliases, then afterAll archives
// the projects and deactivates the people. Self-signup only accepts @aplyd.com, so the alias is
// nakul17+…@aplyd.com.
import { afterAll, describe, expect, it } from "vitest";
import { canDropOnSection, closeControlOffered, completeTickAllowed, moveMenuSections } from "@/lib/approver-ui";
import { assertStoryTargetAllowed } from "../base-url";
import { account, superAdmin, task, withVersion, type Account } from "../../helpers";

assertStoryTargetAllowed();

type Note = { id: string; text: string; href: string; createdAt: string };
type BoardTask = { id: string; canClose: boolean; sectionId: string; completedAt: string | null };
type BoardSection = { id: string; name: string; isDone: boolean; tasks: BoardTask[] };
type Proj = { id: string; name: string; todo: string; doing: string; done: string };

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
const people: Account[] = [];
const projectIds: string[] = [];

/** A throwaway person. The display name starts with ZZ-TEST; the address is a run-unique nakul17+ alias. */
async function zzAccount(role: string) {
  const n = seq++;
  const slug = role.toLowerCase().replace(/[^a-z0-9]+/g, "") || "user";
  const email = `nakul17+zz-2660-${RUN}-${slug}-${n}@aplyd.com`;
  const who = await account(`ZZ-TEST ${role} ${RUN}-${n}`, email);
  people.push(who);
  return who;
}

async function zzProject(creator: Account, leader: Account, members: { who: Account; role?: "EDITOR" | "VIEWER" }[] = []): Promise<Proj> {
  const name = `ZZ-TEST ${RUN}-${seq++}`;
  const r = await creator.c.post("/api/projects", { name, leaderId: leader.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  projectIds.push(id);
  for (const m of members) {
    expect((await leader.c.post(`/api/projects/${id}/members`, { userId: m.who.id, role: m.role ?? "EDITOR" })).status).toBe(201);
  }
  const p = await leader.c.get(`/api/projects/${id}`);
  const sections = p.json.project.sections as { id: string; name: string; isDone: boolean }[];
  return { id, name, todo: sections[0].id, doing: sections[1].id, done: sections.find((s) => s.isDone)!.id };
}

const zzTitle = (label: string) => `ZZ-TEST ${label} ${RUN}-${seq++}`;

async function zzTask(who: Account, projectId: string, body: Record<string, unknown> = {}) {
  const given = typeof body.title === "string" ? body.title : "task";
  const title = given.startsWith("ZZ-TEST") ? given : zzTitle(given);
  return task(who, projectId, { ...body, title });
}

/**
 * Every page, not the default first 50. `limit` is capped at 200 by the API, so follow `next`
 * (`before`) until the inbox is exhausted. A new notice cannot sit on a later page unseen.
 */
const notes = async (who: Account) => {
  const items: Note[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 25; page++) {
    const q = new URLSearchParams({ limit: "200" });
    if (cursor) q.set("before", cursor);
    const r = await who.c.get(`/api/notifications?${q.toString()}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    items.push(...(r.json.items as Note[]));
    cursor = (r.json.next as string | null) ?? null;
    if (!cursor) return items;
  }
  throw new Error("notifications still paging after 25 pages of 200");
};

const taskOf = async (who: Account, id: string) => (await who.c.get(`/api/tasks/${id}`)).json.task as {
  assignee: { id: string }; approver: { id: string } | null; awaitingApproval: boolean; completedAt: string | null;
  canClose: boolean; sectionId: string; section: { id: string; isDone: boolean };
};

async function board(who: Account, projectId: string) {
  const r = await who.c.get(`/api/projects/${projectId}/tasks`);
  expect(r.status).toBe(200);
  return r.json.sections as BoardSection[];
}

const card = (sections: BoardSection[], id: string) => {
  const found = sections.flatMap((s) => s.tasks).find((t) => t.id === id);
  expect(found, id).toBeTruthy();
  return found!;
};

describe("APL-2522 approver edge cases (APL-2660)", () => {
  afterAll(async () => {
    const sa = await superAdmin();
    const problems: string[] = [];
    for (const id of projectIds) {
      const added = await sa.c.post(`/api/projects/${id}/members`, { userId: sa.id, role: "EDITOR" });
      if (added.status !== 201 && !(added.status === 409 && /already a member/.test(added.json?.error ?? ""))) {
        problems.push(`add member ${id}: ${added.status} ${JSON.stringify(added.json)}`);
      }
      const led = await sa.c.post(`/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
      if (led.status !== 200 && !(led.status === 400 && /already the Leader/.test(led.json?.error ?? ""))) {
        problems.push(`change leader ${id}: ${led.status} ${JSON.stringify(led.json)}`);
      }
      const archived = await sa.c.post(`/api/projects/${id}/archive`);
      if (archived.status !== 200) problems.push(`archive ${id}: ${archived.status} ${JSON.stringify(archived.json)}`);
    }
    for (const who of people) {
      if (who.id === sa.id) continue;
      const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
      if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) {
        problems.push(`deactivate ${who.email}: ${off.status} ${JSON.stringify(off.json)}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("AC1 (set by a plain creator): an Editor who created a task and is not a Leader or Admin names a valid approver, and a Viewer, non-member, deactivated person or the current assignee is refused", async () => {
    const sa = await superAdmin();
    const lead = await zzAccount("lead");
    const creator = await zzAccount("creator");
    const worker = await zzAccount("worker");
    const editor = await zzAccount("editor");
    const viewer = await zzAccount("viewer");
    const outsider = await zzAccount("outsider");
    const gone = await zzAccount("gone");
    const p = await zzProject(lead, lead, [
      { who: creator }, { who: worker }, { who: editor }, { who: gone }, { who: viewer, role: "VIEWER" },
    ]);
    const t = await zzTask(creator, p.id, { title: "Plain creator", assigneeId: worker.id });
    const put = async (id: string) => creator.c.put(`/api/tasks/${t}/approver`, await withVersion(creator, t, { approverId: id }));

    expect((await put(editor.id)).status).toBe(200);
    expect((await taskOf(creator, t)).approver?.id).toBe(editor.id);
    expect((await put(lead.id)).status).toBe(200);
    expect((await taskOf(creator, t)).approver?.id).toBe(lead.id);

    expect((await sa.c.post(`/api/team/${gone.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    for (const id of [viewer.id, outsider.id, gone.id, worker.id]) {
      expect((await put(id)).status).toBe(400);
    }
    expect((await taskOf(creator, t)).approver?.id).toBe(lead.id);
  });

  it("AC2 (close by the approver): the approver holds the task and selects Close, and the task completes", async () => {
    const lead = await zzAccount("lead");
    const worker = await zzAccount("worker");
    const boss = await zzAccount("boss");
    const p = await zzProject(lead, lead, [{ who: worker }, { who: boss }]);
    const t = await zzTask(lead, p.id, { title: "Ready to close", assigneeId: worker.id, approverId: boss.id });
    expect((await worker.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
    const held = await taskOf(boss, t);
    expect(held.assignee.id).toBe(boss.id);
    expect(held.awaitingApproval).toBe(true);
    // Close on the task detail posts complete.
    expect(closeControlOffered({ canEdit: true, done: false, canClose: held.canClose })).toBe(true);
    expect((await boss.c.post(`/api/tasks/${t}/complete`, await withVersion(boss, t))).status).toBe(200);
    const done = await taskOf(boss, t);
    expect(done.completedAt).not.toBeNull();
    expect(done.section.isDone).toBe(true);
  });

  it("AC3 (close by another Editor refused): an Editor who is neither the approver, the Leader nor an Admin is refused in the UI and on the server, and the task stays open", async () => {
    const lead = await zzAccount("lead");
    const worker = await zzAccount("worker");
    const boss = await zzAccount("boss");
    const bystander = await zzAccount("bystander");
    const p = await zzProject(lead, lead, [{ who: worker }, { who: boss }, { who: bystander }]);
    const t = await zzTask(lead, p.id, { title: "Not theirs to close", assigneeId: worker.id, approverId: boss.id });

    const detail = await taskOf(bystander, t);
    expect(detail.canClose).toBe(false);
    expect(closeControlOffered({ canEdit: true, done: false, canClose: detail.canClose })).toBe(false);
    const row = card(await board(bystander, p.id), t);
    expect(completeTickAllowed({ canWrite: true, canClose: row.canClose, completedAt: row.completedAt })).toBe(false);

    expect((await bystander.c.post(`/api/tasks/${t}/complete`, await withVersion(bystander, t))).status).toBe(403);
    expect((await bystander.c.post(`/api/tasks/${t}/move`, await withVersion(bystander, t, { sectionId: p.done }))).status).toBe(403);
    const stayed = await taskOf(lead, t);
    expect(stayed.completedAt).toBeNull();
    expect(stayed.sectionId).not.toBe(p.done);
    expect(stayed.awaitingApproval).toBe(false);
  });

  it("AC4 (board drag to Done): a person who may not close it is refused, the task stays open, and Move to omits Done; the approver, the Leader or an Admin dragging it to Done completes it", async () => {
    const sa = await superAdmin();
    const lead = await zzAccount("lead");
    const worker = await zzAccount("worker");
    const boss = await zzAccount("boss");
    const bystander = await zzAccount("bystander");
    const orgAdmin = await zzAccount("orgadmin");
    expect((await sa.c.patch(`/api/team/${orgAdmin.id}`, { orgRole: "ADMIN" })).status).toBe(200);
    const p = await zzProject(lead, lead, [{ who: worker }, { who: boss }, { who: bystander }]);
    const blocked = await zzTask(lead, p.id, { title: "No drop", assigneeId: worker.id, approverId: boss.id });
    const forBoss = await zzTask(lead, p.id, { title: "Boss drops", assigneeId: worker.id, approverId: boss.id });
    const forLead = await zzTask(lead, p.id, { title: "Leader drops", assigneeId: worker.id, approverId: boss.id });
    const forAdmin = await zzTask(lead, p.id, { title: "Admin drops", assigneeId: worker.id, approverId: boss.id });

    const mine = card(await board(bystander, p.id), blocked);
    expect(canDropOnSection(mine, true)).toBe(false);
    expect(moveMenuSections(await board(bystander, p.id), mine).some((s) => s.isDone)).toBe(false);
    expect((await bystander.c.post(`/api/tasks/${blocked}/move`, await withVersion(bystander, blocked, { sectionId: p.done }))).status).toBe(403);
    expect((await taskOf(lead, blocked)).completedAt).toBeNull();

    for (const [who, id] of [[boss, forBoss], [lead, forLead], [orgAdmin, forAdmin]] as const) {
      const row = card(await board(who, p.id), id);
      expect(row.canClose).toBe(true);
      expect(canDropOnSection(row, true)).toBe(true);
      expect(moveMenuSections(await board(who, p.id), row).some((s) => s.isDone && s.name === "Done")).toBe(true);
      expect((await who.c.post(`/api/tasks/${id}/move`, await withVersion(who, id, { sectionId: p.done }))).status).toBe(200);
      expect((await taskOf(who, id)).completedAt).not.toBeNull();
    }
  });

  it("AC5 (send back: who is notified): the previous assignee receives the notice, nobody else is notified, and the task stays open with them as assignee", async () => {
    const lead = await zzAccount("lead");
    const worker = await zzAccount("worker");
    const boss = await zzAccount("boss");
    const collab = await zzAccount("collab");
    const bystander = await zzAccount("bystander");
    const p = await zzProject(lead, lead, [{ who: worker }, { who: boss }, { who: collab }, { who: bystander }]);
    const title = zzTitle("notice only the sender");
    const t = await zzTask(lead, p.id, { title, assigneeId: worker.id, approverId: boss.id, collaboratorIds: [collab.id] });
    expect((await worker.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
    const before = new Map<string, Set<string>>();
    for (const who of [worker, boss, lead, collab, bystander]) before.set(who.id, new Set((await notes(who)).map((n) => n.id)));

    expect((await boss.c.post(`/api/tasks/${t}/send-back`)).status).toBe(200);
    const fresh = async (who: Account) => (await notes(who)).filter((n) => !before.get(who.id)!.has(n.id));
    const toWorker = await fresh(worker);
    expect(toWorker.map((n) => n.text)).toEqual([`${boss.name} sent "${title}" back to you.`]);
    for (const who of [boss, lead, collab, bystander]) {
      expect((await fresh(who)).filter((n) => n.text.includes(title))).toEqual([]);
    }
    const back = await taskOf(worker, t);
    expect(back.completedAt).toBeNull();
    expect(back.assignee.id).toBe(worker.id);
    expect(back.awaitingApproval).toBe(false);
  });

  it("AC6 (send back with the Leader as approver): the previous assignee has left, been deactivated or made a Viewer, and Send back leaves the task not awaiting approval and reassignable", async () => {
    const sa = await superAdmin();
    for (const kind of ["left", "deactivated", "viewer"] as const) {
      const lead = await zzAccount("lead");
      const worker = await zzAccount("worker");
      const spare = await zzAccount("spare");
      const p = await zzProject(lead, lead, [{ who: worker }, { who: spare }]);
      const t = await zzTask(lead, p.id, { title: kind, assigneeId: worker.id, approverId: lead.id });
      expect((await worker.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
      if (kind === "left") expect((await lead.c.del(`/api/projects/${p.id}/members/${worker.id}`)).status).toBe(204);
      else if (kind === "deactivated") expect((await sa.c.post(`/api/team/${worker.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
      else expect((await lead.c.patch(`/api/projects/${p.id}/members/${worker.id}`, { role: "VIEWER" })).status).toBe(200);

      expect((await lead.c.post(`/api/tasks/${t}/send-back`)).status).toBe(200);
      const got = await taskOf(lead, t);
      expect(got.awaitingApproval).toBe(false);
      expect(got.completedAt).toBeNull();
      expect((await lead.c.post(`/api/tasks/${t}/assign`, await withVersion(lead, t, { assigneeId: spare.id }))).status).toBe(200);
      const moved = await taskOf(lead, t);
      expect(moved.assignee.id).toBe(spare.id);
      expect(moved.awaitingApproval).toBe(false);
    }
  });

  it("AC7 (approver deactivated): the Leader becomes the approver and the holder of tasks awaiting approval, and gets one notice per project with the count", async () => {
    const sa = await superAdmin();
    const lead = await zzAccount("lead");
    const worker = await zzAccount("worker");
    const boss = await zzAccount("boss");
    const p1 = await zzProject(lead, lead, [{ who: worker }, { who: boss }]);
    const p2 = await zzProject(lead, lead, [{ who: worker }, { who: boss }]);
    const waiting = await zzTask(lead, p1.id, { title: "Awaiting", assigneeId: worker.id, approverId: boss.id });
    const quiet = await zzTask(lead, p1.id, { title: "Open", assigneeId: worker.id, approverId: boss.id });
    const elsewhere = await zzTask(lead, p2.id, { title: "Other project", assigneeId: worker.id, approverId: boss.id });
    expect((await worker.c.post(`/api/tasks/${waiting}/send-for-approval`)).status).toBe(200);
    const before = new Set((await notes(lead)).map((n) => n.id));

    expect((await sa.c.post(`/api/team/${boss.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);

    const held = await taskOf(lead, waiting);
    expect(held.approver?.id).toBe(lead.id);
    expect(held.assignee.id).toBe(lead.id);
    expect(held.awaitingApproval).toBe(true);
    const open = await taskOf(lead, quiet);
    expect(open.approver?.id).toBe(lead.id);
    expect(open.assignee.id).toBe(worker.id);
    expect(open.awaitingApproval).toBe(false);
    expect((await taskOf(lead, elsewhere)).approver?.id).toBe(lead.id);

    const fresh = (await notes(lead)).filter((n) => !before.has(n.id) && /handed over/.test(n.text));
    const forProject = (id: string) => fresh.filter((n) => n.href.includes(id));
    expect(forProject(p1.id)).toHaveLength(1);
    expect(forProject(p1.id)[0].text).toMatch(/you now approve 2 tasks/);
    expect(forProject(p2.id)).toHaveLength(1);
    expect(forProject(p2.id)[0].text).toMatch(/you now approve 1 task/);
  });

  it("AC8 (Leader is the assignee): when the approver is deactivated or removed, the approver is cleared and the Leader gets the approver cleared message", async () => {
    const sa = await superAdmin();
    for (const kind of ["deactivated", "removed"] as const) {
      const lead = await zzAccount("lead");
      const ed = await zzAccount("ed");
      const p = await zzProject(lead, lead, [{ who: ed }]);
      const t = await zzTask(lead, p.id, { title: `Leader holds ${kind}`, assigneeId: lead.id, approverId: ed.id });
      const before = new Set((await notes(lead)).map((n) => n.id));
      if (kind === "deactivated") expect((await sa.c.post(`/api/team/${ed.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
      else expect((await lead.c.del(`/api/projects/${p.id}/members/${ed.id}`)).status).toBe(204);

      const got = await taskOf(lead, t);
      expect(got.approver).toBeNull();
      expect(got.assignee.id).toBe(lead.id);
      const cleared = (await notes(lead)).filter((n) => !before.has(n.id) && /no longer has an approver/.test(n.text));
      expect(cleared.length).toBeGreaterThanOrEqual(1);
      expect(cleared.some((n) => n.href.includes(p.id))).toBe(true);
    }
  });
});
