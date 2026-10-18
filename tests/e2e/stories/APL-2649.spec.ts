// SHO-BUG Hide Undo toast for Editors after delete (Linear APL-2649, PR #14; follow-up to APL-2640). Acceptance criteria AC1 and AC2.
// The Super Admin acts as Leader and Admin; the plain Member (SHO_MEMBER_*) is the Editor. Projects are ZZ-TEST and archived afterwards.
import { test, expect } from "../support";
import { newProject, newTask, type Who } from "../g2";
import { deleteTask, undoToast } from "../helpers/jim-http";

test.beforeAll(() => {
  test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
});

/** Open the task on its project page and move it to Trash through the task's own dialog. */
async function trashFromScreen(who: Who, projectId: string, taskId: string) {
  await who.page.goto(`/projects/${projectId}?task=${taskId}`);
  await who.page.getByRole("button", { name: "Move to Trash" }).click();
  await who.page.getByRole("dialog", { name: "Move to Trash?" }).getByRole("button", { name: "Move to Trash" }).click();
  await expect(who.page.getByRole("dialog", { name: "Move to Trash?" })).toHaveCount(0);
}

test.describe("APL-2649", () => {
  test("AC1: an Editor who deletes a task does not see the Undo toast", async ({ admin, member, later }) => {
    const p = await newProject(admin, later, { label: "2649 editor", members: [{ who: member, role: "EDITOR" }] });
    const t = await newTask(admin, p.id);
    await trashFromScreen(member, p.id, t);
    await member.page.waitForTimeout(1000); // the toast is raised as soon as the answer arrives; give it time to (not) appear
    await expect(undoToast(member).getByRole("button", { name: "Undo" })).toHaveCount(0);
    expect((await member.api.get(`/api/tasks/${t}`)).status).toBe(404); // the delete itself went through
    // The server sends no Undo id either, so no other screen can raise the toast.
    const t2 = await newTask(admin, p.id);
    const del = await deleteTask(member, t2);
    expect(del.status).toBe(204);
    expect(del.undoId).toBeNull();
  });

  test("AC2: a Leader or Admin who deletes a task still sees the Undo toast, and Undo brings the task back", async ({ admin, later }) => {
    const p = await newProject(admin, later, { label: "2649 leader" });
    const t = await newTask(admin, p.id);
    await trashFromScreen(admin, p.id, t);
    const toast = undoToast(admin);
    await expect(toast).toContainText("Task deleted.");
    await expect.poll(async () => (await admin.api.get(`/api/tasks/${t}`)).status).toBe(404);
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(admin.page.getByText("Undone: task deleted.")).toBeVisible();
    await expect.poll(async () => (await admin.api.get(`/api/tasks/${t}`)).status).toBe(200);
  });
});
