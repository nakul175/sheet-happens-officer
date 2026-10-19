// APL-2870. Undo of a reopen closes every subtask the reopen changed again, also one moved to
// Trash since (the APL-2755 rule). A subtask ticked done on its own since keeps its own time.
// Setup goes through the app API. No qa:TC id is assigned on the issue, so every title says qa:TC missing.
import { afterAll, describe, expect, it } from "vitest";
import { withVersion, task, type Account } from "./helpers";
import { zzTestData } from "./zz-test-data";

const zz = zzTestData("2870");

afterAll(async () => {
  const problems = await zz.cleanUp();
  expect(problems, problems.join("\n")).toEqual([]);
}, 120000);

const completedAt = async (who: Account, id: string) => {
  const res = await who.c.get(`/api/tasks/${id}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.task.completedAt as string | null;
};

describe("qa:TC missing APL-2870 route: undo of a reopen", () => {
  it("qa:TC missing a reopened subtask moved to Trash closes again, and one ticked on its own keeps its time", async () => {
    const lead = await zz.person("lead");
    const proj = await zz.project(lead);
    const parent = await task(lead, proj.id, { title: "ZZ-TEST P", sectionId: proj.doing });
    const a = await task(lead, proj.id, { title: "ZZ-TEST A", parentId: parent });
    const c = await task(lead, proj.id, { title: "ZZ-TEST C", parentId: parent });

    // P completes together with A and C.
    const done = await lead.c.post(`/api/tasks/${parent}/complete`, await withVersion(lead, parent, { completeAll: true }));
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const parentAt = await completedAt(lead, parent);
    expect(parentAt).not.toBeNull();
    expect(await completedAt(lead, a)).toBe(parentAt);
    expect(await completedAt(lead, c)).toBe(parentAt);

    // Reopening P reopens A and C.
    const reopen = await lead.c.post(`/api/tasks/${parent}/reopen`);
    expect(reopen.status, JSON.stringify(reopen.json)).toBe(200);
    const undoId = reopen.headers.get("x-undo-id");
    expect(undoId).toBeTruthy();
    for (const id of [parent, a, c]) expect(await completedAt(lead, id), id).toBeNull();

    // AC2: C is ticked done on its own. AC1: A goes to Trash.
    expect((await lead.c.post(`/api/tasks/${c}/complete`, await withVersion(lead, c))).status).toBe(200);
    const cOwnAt = await completedAt(lead, c);
    expect(cOwnAt).not.toBeNull();
    expect(cOwnAt).not.toBe(parentAt);
    expect((await lead.c.del(`/api/tasks/${a}`)).status).toBe(204);
    const trash = await lead.c.get(`/api/projects/${proj.id}/trash`);
    expect((trash.json.items as { id: string }[]).some((i) => i.id === a)).toBe(true);

    // Undo the reopen of P.
    const undo = await lead.c.post(`/api/actions/${undoId}/undo`);
    expect(undo.status, JSON.stringify(undo.json)).toBe(200);
    expect(await completedAt(lead, parent)).toBe(parentAt);
    expect(await completedAt(lead, c)).toBe(cOwnAt);

    // A comes back from Trash complete, on P's original time.
    expect((await lead.c.post(`/api/tasks/${a}/restore`)).status).toBe(200);
    expect(await completedAt(lead, a)).toBe(parentAt);
  });
});
