// SHO-BUG-13 Task PATCH without a version silently overwrites a concurrent edit (Linear APL-2648, PR #13).
// The issue's four unnumbered acceptance criteria are taken in order as AC1 to AC4.
// The Super Admin acts as Leader and as "the other person" where one session is enough; the plain Member (SHO_MEMBER_*) is User B
// in the two-person case. Every edit this spec makes on purpose sends a version. A PATCH that omits it is refused.
import { test, expect, zz } from "../support";
import { getTask, newProject, newTask } from "../g2";
import { patchCurrent } from "../helpers/jim-http";


test.describe("SHO-BUG-13 / APL-2648", () => {
  test("AC1: a task PATCH without expectedUpdatedAt is refused with 400 and changes nothing", async ({ admin, later }) => {
    const p = await newProject(admin, later, { label: "bug13 no version" });
    const t = await newTask(admin, p.id, { dueDate: "2026-11-03", title: zz("original"), priority: "LOW" });
    const before = await getTask(admin, t);
    const r = await admin.api.patch(`/api/tasks/${t}`, { title: zz("overwritten"), priority: "URGENT" });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toContain("expectedUpdatedAt is required");
    const after = await getTask(admin, t);
    expect(after.title).toBe(before.title);
    expect(after.priority).toBe("LOW");
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  test("AC1 (two people): User B's change survives User A's PATCH that omits the version", async ({ admin, member, later }) => {
    const p = await newProject(admin, later, { label: "bug13 two people", members: [{ who: member, role: "EDITOR" }] });
    const t = await newTask(admin, p.id, { dueDate: "2026-11-03", title: zz("v1") });
    const theirs = zz("B's title");
    expect((await patchCurrent(member, t, { title: theirs })).status).toBe(200); // User B saves
    const a = await admin.api.patch(`/api/tasks/${t}`, { title: zz("A's title") }); // User A, no version
    expect(a.status).toBe(400);
    expect((await getTask(admin, t)).title).toBe(theirs);
  });

  test("AC2: a stale expectedUpdatedAt gets the version_conflict envelope and preserves the current values", async ({ admin, later }) => {
    const p = await newProject(admin, later, { label: "bug13 stale" });
    const t = await newTask(admin, p.id, { dueDate: "2026-11-03", title: zz("original") });
    const seen = (await getTask(admin, t)).updatedAt as string;
    const theirs = zz("theirs");
    expect((await patchCurrent(admin, t, { title: theirs })).status).toBe(200);
    const r = await admin.api.patch(`/api/tasks/${t}`, { title: zz("mine"), expectedUpdatedAt: seen });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: { code: "version_conflict", message: `${admin.user.name} changed this task while you were editing it.` } });
    expect((await getTask(admin, t)).title).toBe(theirs);
  });

  test("AC3: on the screen, the stale warning keeps my edit and 'Re-apply my edit' saves it", async ({ admin, later }) => {
    const p = await newProject(admin, later, { label: "bug13 screen" });
    const t = await newTask(admin, p.id, { dueDate: "2026-11-03" });
    await admin.page.goto(`/projects/${p.id}?task=${t}`);
    const title = admin.page.getByLabel("Title", { exact: true });
    await expect(title).toBeVisible();
    // A save made elsewhere after the task was opened (same person, through the API).
    expect((await patchCurrent(admin, t, { priority: "HIGH" })).status).toBe(200);
    const mine = zz("bug13 my edit");
    await title.fill(mine);
    await title.press("Enter");
    const warn = admin.page.getByRole("alert").filter({ hasText: "changed this task while you were editing" });
    await expect(warn).toBeVisible();
    await expect(warn).toContainText(mine);
    expect((await getTask(admin, t)).title).not.toBe(mine); // not silently saved
    await warn.getByRole("button", { name: "Re-apply my edit" }).click();
    await expect.poll(async () => (await getTask(admin, t)).title).toBe(mine);
    expect((await getTask(admin, t)).priority).toBe("HIGH"); // the other save was kept
  });

  test("AC4 (matching version): an edit made on the current version saves", async ({ admin, later }) => {
    // AC4's other two cases are the AC1 (missing version) and AC2 (stale version) tests above.
    const p = await newProject(admin, later, { label: "bug13 matching" });
    const t = await newTask(admin, p.id, { dueDate: "2026-11-03" });
    const seen = (await getTask(admin, t)).updatedAt as string;
    const saved = zz("saved");
    const r = await admin.api.patch(`/api/tasks/${t}`, { title: saved, expectedUpdatedAt: seen });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.task.title).toBe(saved);
  });
});
