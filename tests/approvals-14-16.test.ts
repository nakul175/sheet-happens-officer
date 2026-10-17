// SHO-US-14.16: Waiting on me / Waiting on others in My tasks.
import { describe, expect, it } from "vitest";
import { account, project, task } from "./helpers";

describe("approvals view (14.16)", () => {
  it("lists tasks held for my approval with their age, and the sender sees them under Waiting on others", async () => {
    const lead = await account("lead");
    const worker = await account("worker");
    const boss = await account("boss");
    const p = await project(lead, lead, [{ who: worker }, { who: boss }]);
    const t = await task(lead, p.id, { assigneeId: worker.id, approverId: boss.id });
    const plain = await task(lead, p.id, { assigneeId: boss.id });

    let mine = (await boss.c.get("/api/my-tasks")).json;
    expect(mine.waitingOnMe).toEqual([]); // nothing sent yet
    expect((await worker.c.get("/api/my-tasks")).json.waitingOnOthers).toEqual([]);

    expect((await worker.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
    mine = (await boss.c.get("/api/my-tasks")).json;
    expect(mine.waitingOnMe.map((x: { id: string }) => x.id)).toEqual([t]);
    expect(mine.waitingOnMe[0].waitingDays).toBe(0);
    expect(mine.later.map((x: { id: string }) => x.id)).toEqual([plain]); // not mixed into Later

    const theirs = (await worker.c.get("/api/my-tasks")).json;
    expect(theirs.waitingOnOthers.map((x: { id: string }) => x.id)).toEqual([t]);
    expect(theirs.waitingOnOthers[0].assignee.id).toBe(boss.id);
    expect([...theirs.overdue, ...theirs.next7, ...theirs.later, ...theirs.waitingOnMe].some((x: { id: string }) => x.id === t)).toBe(false);

    // Close from the row is one request, and Undo is offered
    const r = await boss.c.post(`/api/tasks/${t}/complete`, {});
    expect(r.status).toBe(200);
    expect(r.headers.get("x-undo-id")).toBeTruthy();
    expect((await boss.c.get("/api/my-tasks")).json.waitingOnMe).toEqual([]);
    expect((await worker.c.get("/api/my-tasks")).json.waitingOnOthers).toEqual([]);
  });

  it("send back returns it to the sender and empties both groups", async () => {
    const lead = await account("lead");
    const worker = await account("worker");
    const boss = await account("boss");
    const p = await project(lead, lead, [{ who: worker }, { who: boss }]);
    const t = await task(lead, p.id, { assigneeId: worker.id, approverId: boss.id });
    await worker.c.post(`/api/tasks/${t}/send-for-approval`);
    expect((await boss.c.post(`/api/tasks/${t}/send-back`)).status).toBe(200);
    expect((await boss.c.get("/api/my-tasks")).json.waitingOnMe).toEqual([]);
    const w = (await worker.c.get("/api/my-tasks")).json;
    expect(w.waitingOnOthers).toEqual([]);
    expect([...w.overdue, ...w.next7, ...w.later].some((x: { id: string }) => x.id === t)).toBe(true);
  });
});
