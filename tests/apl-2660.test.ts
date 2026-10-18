// APL-2660: approver edge cases from APL-2522 that the first staging run did not cover.
// One test per acceptance criterion. The scenario name is the test title.
import { describe, expect, it } from "vitest";
import { canDropOnSection, closeControlOffered, completeTickAllowed, moveMenuSections } from "@/lib/approver-ui";
import { account, admin, project, superAdmin, task, type Account } from "./helpers";

type Note = { id: string; text: string; href: string };
type BoardTask = { id: string; canClose: boolean; sectionId: string; completedAt: string | null };
type BoardSection = { id: string; name: string; isDone: boolean; tasks: BoardTask[] };

const notes = async (who: Account) => (await who.c.get("/api/notifications")).json.items as Note[];
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

describe("APL-2660 approver edge cases", () => {
  it("AC1 (set by a plain creator): an Editor who created a task and is not a Leader or Admin names a valid approver, and a Viewer, non-member, deactivated person or the current assignee is refused", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const creator = await account("creator");
    const worker = await account("worker");
    const editor = await account("editor");
    const viewer = await account("viewer");
    const outsider = await account("outsider");
    const gone = await account("gone");
    const p = await project(lead, lead, [
      { who: creator }, { who: worker }, { who: editor }, { who: gone }, { who: viewer, role: "VIEWER" },
    ]);
    const t = await task(creator, p.id, { title: "Plain creator", assigneeId: worker.id });
    const put = (id: string) => creator.c.put(`/api/tasks/${t}/approver`, { approverId: id });

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
    const lead = await account("lead");
    const worker = await account("worker");
    const boss = await account("boss");
    const p = await project(lead, lead, [{ who: worker }, { who: boss }]);
    const t = await task(lead, p.id, { title: "Ready to close", assigneeId: worker.id, approverId: boss.id });
    expect((await worker.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
    const held = await taskOf(boss, t);
    expect(held.assignee.id).toBe(boss.id);
    expect(held.awaitingApproval).toBe(true);
    // Close on the task detail posts complete.
    expect(closeControlOffered({ canEdit: true, done: false, canClose: held.canClose })).toBe(true);
    expect((await boss.c.post(`/api/tasks/${t}/complete`)).status).toBe(200);
    const done = await taskOf(boss, t);
    expect(done.completedAt).not.toBeNull();
    expect(done.section.isDone).toBe(true);
  });

  it("AC3 (close by another Editor refused): an Editor who is neither the approver, the Leader nor an Admin is refused in the UI and on the server, and the task stays open", async () => {
    const lead = await account("lead");
    const worker = await account("worker");
    const boss = await account("boss");
    const bystander = await account("bystander");
    const p = await project(lead, lead, [{ who: worker }, { who: boss }, { who: bystander }]);
    const t = await task(lead, p.id, { title: "Not theirs to close", assigneeId: worker.id, approverId: boss.id });

    const detail = await taskOf(bystander, t);
    expect(detail.canClose).toBe(false);
    expect(closeControlOffered({ canEdit: true, done: false, canClose: detail.canClose })).toBe(false);
    const row = card(await board(bystander, p.id), t);
    expect(completeTickAllowed({ canWrite: true, canClose: row.canClose, completedAt: row.completedAt })).toBe(false);

    expect((await bystander.c.post(`/api/tasks/${t}/complete`)).status).toBe(403);
    expect((await bystander.c.post(`/api/tasks/${t}/move`, { sectionId: p.done })).status).toBe(403);
    const stayed = await taskOf(lead, t);
    expect(stayed.completedAt).toBeNull();
    expect(stayed.sectionId).not.toBe(p.done);
    expect(stayed.awaitingApproval).toBe(false);
  });

  it("AC4 (board drag to Done): a person who may not close it is refused, the task stays open, and Move to omits Done; the approver, the Leader or an Admin dragging it to Done completes it", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const worker = await account("worker");
    const boss = await account("boss");
    const bystander = await account("bystander");
    const orgAdmin = await admin(sa, "orgadmin");
    const p = await project(lead, lead, [{ who: worker }, { who: boss }, { who: bystander }]);
    const blocked = await task(lead, p.id, { title: "No drop", assigneeId: worker.id, approverId: boss.id });
    const forBoss = await task(lead, p.id, { title: "Boss drops", assigneeId: worker.id, approverId: boss.id });
    const forLead = await task(lead, p.id, { title: "Leader drops", assigneeId: worker.id, approverId: boss.id });
    const forAdmin = await task(lead, p.id, { title: "Admin drops", assigneeId: worker.id, approverId: boss.id });

    const mine = card(await board(bystander, p.id), blocked);
    expect(canDropOnSection(mine, true)).toBe(false);
    expect(moveMenuSections(await board(bystander, p.id), mine).some((s) => s.isDone)).toBe(false);
    expect((await bystander.c.post(`/api/tasks/${blocked}/move`, { sectionId: p.done })).status).toBe(403);
    expect((await taskOf(lead, blocked)).completedAt).toBeNull();

    for (const [who, id] of [[boss, forBoss], [lead, forLead], [orgAdmin, forAdmin]] as const) {
      const row = card(await board(who, p.id), id);
      expect(row.canClose).toBe(true);
      expect(canDropOnSection(row, true)).toBe(true);
      expect(moveMenuSections(await board(who, p.id), row).some((s) => s.isDone && s.name === "Done")).toBe(true);
      expect((await who.c.post(`/api/tasks/${id}/move`, { sectionId: p.done })).status).toBe(200);
      expect((await taskOf(who, id)).completedAt).not.toBeNull();
    }
  });

  it("AC5 (send back: who is notified): the previous assignee receives the notice, nobody else is notified, and the task stays open with them as assignee", async () => {
    const lead = await account("lead");
    const worker = await account("worker");
    const boss = await account("boss");
    const collab = await account("collab");
    const bystander = await account("bystander");
    const p = await project(lead, lead, [{ who: worker }, { who: boss }, { who: collab }, { who: bystander }]);
    const title = "Notice only the sender";
    const t = await task(lead, p.id, { title, assigneeId: worker.id, approverId: boss.id, collaboratorIds: [collab.id] });
    expect((await worker.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
    const before = new Map<string, Set<string>>();
    for (const who of [worker, boss, lead, collab, bystander]) before.set(who.id, new Set((await notes(who)).map((n) => n.id)));

    expect((await boss.c.post(`/api/tasks/${t}/send-back`)).status).toBe(200);
    const fresh = async (who: Account) => (await notes(who)).filter((n) => !before.get(who.id)!.has(n.id));
    const toWorker = await fresh(worker);
    expect(toWorker.map((n) => n.text)).toEqual([`Boss sent "${title}" back to you.`]);
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
      const lead = await account("lead");
      const worker = await account("worker");
      const spare = await account("spare");
      const p = await project(lead, lead, [{ who: worker }, { who: spare }]);
      const t = await task(lead, p.id, { title: kind, assigneeId: worker.id, approverId: lead.id });
      expect((await worker.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
      if (kind === "left") expect((await lead.c.del(`/api/projects/${p.id}/members/${worker.id}`)).status).toBe(204);
      else if (kind === "deactivated") expect((await sa.c.post(`/api/team/${worker.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
      else expect((await lead.c.patch(`/api/projects/${p.id}/members/${worker.id}`, { role: "VIEWER" })).status).toBe(200);

      expect((await lead.c.post(`/api/tasks/${t}/send-back`)).status).toBe(200);
      const got = await taskOf(lead, t);
      expect(got.awaitingApproval).toBe(false);
      expect(got.completedAt).toBeNull();
      expect((await lead.c.post(`/api/tasks/${t}/assign`, { assigneeId: spare.id })).status).toBe(200);
      const moved = await taskOf(lead, t);
      expect(moved.assignee.id).toBe(spare.id);
      expect(moved.awaitingApproval).toBe(false);
    }
  });

  it("AC7 (approver deactivated): the Leader becomes the approver and the holder of tasks awaiting approval, and gets one notice per project with the count", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const worker = await account("worker");
    const boss = await account("boss");
    const p1 = await project(lead, lead, [{ who: worker }, { who: boss }]);
    const p2 = await project(lead, lead, [{ who: worker }, { who: boss }]);
    const waiting = await task(lead, p1.id, { title: "Awaiting", assigneeId: worker.id, approverId: boss.id });
    const quiet = await task(lead, p1.id, { title: "Open", assigneeId: worker.id, approverId: boss.id });
    const elsewhere = await task(lead, p2.id, { title: "Other project", assigneeId: worker.id, approverId: boss.id });
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
      const lead = await account("lead");
      const ed = await account("ed");
      const p = await project(lead, lead, [{ who: ed }]);
      const t = await task(lead, p.id, { title: `Leader holds ${kind}`, assigneeId: lead.id, approverId: ed.id });
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
