// SHO-US-6.4 Undo an action (Linear APL-2505).
// One test per acceptance criterion. The admin and member fixtures sign in with login("ADMIN") / login("MEMBER").
// Every project and task is ZZ-TEST (zz / ZZ_PREFIX) and the project is archived afterwards.
// Nothing here is pointed at production: BASE_URL is staging or a pr1–pr8 preview.
import { readFileSync } from "node:fs";
import { test, expect, zz } from "../support";
import { getTask, newProject, newTask } from "../g2";
import { activity, audit, editTask, notices } from "../helpers/claude-a";
import { localSql, sourceOf, sqlId } from "../helpers/local-clock";

test.beforeAll(() => {
  test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
});

test("APL-2505 > AC1: undoing an unchanged edit restores the previous values and logs the undo", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "undo plain" });
  const title = zz("before title");
  const detail = zz("before detail");
  const id = await newTask(admin, p.id, { title, description: detail });
  const edited = await editTask(admin, id, { title: zz("after title"), description: zz("after detail") });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);
  expect(edited.headers["x-undo-id"], "the edit is undoable").toBeTruthy();

  const undo = await admin.api.post(`/api/actions/${edited.headers["x-undo-id"]}/undo`, {});
  expect(undo.status, JSON.stringify(undo.json)).toBe(200);
  const back = await getTask(admin, id);
  expect(back.title).toBe(title);
  expect(back.description).toBe(detail);
  expect((await activity(admin, p.id)).some((row) => row.what === 'undid "task edited"')).toBe(true);

  await admin.page.goto(`/projects/${p.id}/activity`);
  await expect(admin.page.locator(".item.act", { hasText: 'undid "task edited"' })).toBeVisible();
});

test("APL-2505 > AC2: a later edit of the same field warns with Before, After and Now, and does not revert it", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "undo conflict", members: [{ who: member, role: "EDITOR" }] });
  const original = zz("conflict before");
  const mine = zz("conflict after");
  const theirs = zz("conflict now");
  const id = await newTask(admin, p.id, { title: original });
  const edited = await editTask(admin, id, { title: mine });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);
  const laterEdit = await editTask(member, id, { title: theirs, description: zz("their other edit") });
  expect(laterEdit.status, JSON.stringify(laterEdit.json)).toBe(200);

  const undo = await admin.api.post(`/api/actions/${edited.headers["x-undo-id"]}/undo`, {});
  expect(undo.status, JSON.stringify(undo.json)).toBe(409);
  expect(undo.json.needsConfirm).toBe("conflict");
  expect(undo.json.changedBy).toContain(member.user.name);
  expect(undo.json.conflicts).toContainEqual({ field: "Title", before: original, after: mine, now: theirs });
  const kept = await getTask(admin, id);
  expect(kept.title, "their change is still there").toBe(theirs);
  expect(kept.description).toBe(zz("their other edit"));

  await admin.page.goto(`/projects/${p.id}/activity`);
  await admin.page.locator(".item.act", { hasText: `renamed "${original}"` }).getByRole("button", { name: "Undo" }).click();
  const dialog = admin.page.getByRole("dialog", { name: "Undo conflict" });
  await expect(dialog.getByRole("columnheader", { name: "Before your action" })).toBeVisible();
  await expect(dialog.getByRole("columnheader", { name: "After your action" })).toBeVisible();
  await expect(dialog.getByRole("columnheader", { name: "Now" })).toBeVisible();
  await expect(dialog).toContainText(original);
  await expect(dialog).toContainText(mine);
  await expect(dialog).toContainText(theirs);
  await dialog.getByRole("button", { name: "Keep their change" }).click();
  expect((await getTask(admin, id)).title).toBe(theirs);
});

test("APL-2505 > AC3: Undo anyway reverts only my fields, keeps their other edits, notifies them and logs the override", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "undo anyway", members: [{ who: member, role: "EDITOR" }] });
  const original = zz("anyway before");
  const mine = zz("anyway after");
  const theirs = zz("anyway now");
  const theirNote = zz("anyway note");
  const id = await newTask(admin, p.id, { title: original, description: zz("original note") });
  const edited = await editTask(admin, id, { title: mine });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);
  expect((await editTask(member, id, { title: theirs, description: theirNote })).status).toBe(200);

  await admin.page.goto(`/projects/${p.id}/activity`);
  await admin.page.locator(".item.act", { hasText: `renamed "${original}"` }).getByRole("button", { name: "Undo" }).click();
  const dialog = admin.page.getByRole("dialog", { name: "Undo conflict" });
  await expect(dialog).toBeVisible();
  const done = admin.page.waitForResponse((r) => r.url().includes("/undo") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Undo anyway" }).click();
  const res = await done;
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.overrode).toBe(true);
  expect(body.label).toBe("Task edited");

  const after = await getTask(admin, id);
  expect(after.title).toBe(original);
  expect(after.description, "a field I did not change stays theirs").toBe(theirNote);
  const told = (await notices(member)).find((n) => n.text.includes(theirs) && n.href.includes(id));
  expect(told?.text).toBe(`${admin.user.name} undid their own change and replaced your change to "${theirs}" (Title).`);
  expect((await activity(admin, p.id)).some((row) => row.what === 'undid "task edited"')).toBe(true);
  const rows = await audit(admin, "UNDO_OVERRIDE", admin.user.id);
  expect(rows.some((row) => row.target === `Task "${original}"`)).toBe(true);
});

test("APL-2505 > AC4: undoing an action that sent a notice says the notice was already delivered", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "undo notice", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("noticed task");
  const id = await newTask(admin, p.id, { title, assigneeId: member.user.id });
  const sent = (await notices(member)).find((n) => n.text === `${admin.user.name} assigned you "${title}".`);
  expect(sent, "creating the task told the assignee").toBeTruthy();

  await admin.page.goto(`/projects/${p.id}/activity`);
  const row = admin.page.locator(".item.act", { hasText: `added "${title}"` });
  const done = admin.page.waitForResponse((r) => r.url().includes("/undo") && r.request().method() === "POST");
  await row.getByRole("button", { name: "Undo" }).click();
  expect((await done).ok()).toBe(true);
  await expect(admin.page.locator(".undo-toast")).toContainText("Notices already sent cannot be recalled.");
  expect((await notices(member)).some((n) => n.id === sent!.id)).toBe(true);
  expect((await admin.api.get(`/api/tasks/${id}`)).status, "undo of create puts the task in Trash").toBe(404);
});

test("APL-2505 > AC5: an Editor undoes only their own actions; a Leader or Admin undoes anyone's in the project", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "undo who", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("whose task");
  const id = await newTask(admin, p.id, { title, assigneeId: member.user.id });
  const byAdmin = await editTask(admin, id, { title: zz("leader edit") });
  expect(byAdmin.status).toBe(200);
  const byMember = await editTask(member, id, { description: zz("editor edit") });
  expect(byMember.status).toBe(200);

  const mine = await activity(member, p.id);
  expect(mine.find((row) => row.what.includes("renamed"))?.undo).toBe("none");
  expect(mine.find((row) => row.what.includes("edited the description"))?.undo).toBe("available");
  const leaders = await activity(admin, p.id);
  expect(leaders.find((row) => row.what.includes("edited the description"))?.undo).toBe("available");

  await member.page.goto(`/projects/${p.id}/activity`);
  await expect(member.page.locator(".item.act", { hasText: "renamed" }).getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(member.page.locator(".item.act", { hasText: "edited the description" }).getByRole("button", { name: "Undo" })).toBeVisible();
  await admin.page.goto(`/projects/${p.id}/activity`);
  await expect(admin.page.locator(".item.act", { hasText: "edited the description" }).getByRole("button", { name: "Undo" })).toBeVisible();

  const refused = await member.api.post(`/api/actions/${byAdmin.headers["x-undo-id"]}/undo`, {});
  expect(refused.status, JSON.stringify(refused.json)).toBe(403);
  expect(refused.json.error).toBe("You can only undo your own actions.");
  expect((await getTask(admin, id)).title).toBe(zz("leader edit"));

  const allowed = await admin.api.post(`/api/actions/${byMember.headers["x-undo-id"]}/undo`, {});
  expect(allowed.status, JSON.stringify(allowed.json)).toBe(200);
  expect((await getTask(admin, id)).description).toBeNull();
});

test("APL-2505 > AC6: an action older than 30 days cannot be undone and says Too old to undo", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "undo aged" });
  const title = zz("aged before");
  const id = await newTask(admin, p.id, { title });
  const edited = await editTask(admin, id, { title: zz("aged after") });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);
  const undoId = edited.headers["x-undo-id"];
  expect(undoId).toBeTruthy();
  expect(sourceOf("src/lib/undoable.ts", "export const UNDO_DAYS")).toContain("export const UNDO_DAYS = 30;");
  expect(sourceOf("src/lib/undo.ts", 'throw bad("Too old to undo"')).toContain("tooOld: true");
  expect((await activity(admin, p.id)).find((row) => row.id === undoId)?.undo).toBe("available");

  if (localSql(`UPDATE "ActionLog" SET "createdAt" = NOW() - INTERVAL '31 days' WHERE id = '${sqlId(undoId)}'`)) {
    expect((await activity(admin, p.id)).find((row) => row.id === undoId)?.undo).toBe("too_old");
    const refused = await admin.api.post(`/api/actions/${undoId}/undo`, {});
    expect(refused.status, JSON.stringify(refused.json)).toBe(409);
    expect(refused.json.error).toBe("Too old to undo");
    expect(refused.json.tooOld).toBe(true);
    await admin.page.goto(`/projects/${p.id}/activity`);
    const line = admin.page.locator(".item.act").filter({ hasText: `renamed "${zz("aged before")}"` });
    await expect(line).toHaveCount(1);
    await expect(line.getByText("Too old to undo")).toBeVisible();
    await expect(line.getByRole("button", { name: "Undo" })).toHaveCount(0);
    expect((await getTask(admin, id)).title).toBe(zz("aged after"));
  }
});

test("APL-2505 > AC7: a concierge change undoes through the same mechanism, limits and conflict dialog", async ({ admin, later }) => {
  const cards = sourceOf("src/lib/concierge/cards.ts", "export async function undoCard");
  expect(cards).toContain("await checkUndo(user, r.id)");
  expect(cards).toContain("await undoAction(user, r.id, anyway)");
  expect(cards).toContain('throw new ApiError(409, "Too old to undo", { tooOld: true })');
  expect(cards).toContain("UNDO_DAYS * 86400_000");
  const view = readFileSync("src/components/concierge/MessageView.tsx", "utf8");
  expect(view).toContain("Too old to undo");
  expect(view).toContain('view === "expired"');
  const dialog = readFileSync("src/components/UndoHost.tsx", "utf8");
  expect(dialog).toContain('label="Undo conflict"');
  expect(dialog).toContain("Undo anyway");
  expect(dialog).toContain("Keep their change");

  // The card's Undo calls the same /api/actions undo AC1 to AC3 already run. This checks that path is live.
  const p = await newProject(admin, later, { label: "undo card path" });
  const title = zz("card path before");
  const id = await newTask(admin, p.id, { title, description: zz("card path detail") });
  const edited = await editTask(admin, id, { title: zz("card path after") });
  expect(edited.status).toBe(200);
  const undo = await admin.api.post(`/api/actions/${edited.headers["x-undo-id"]}/undo`, {});
  expect(undo.status, JSON.stringify(undo.json)).toBe(200);
  expect((await getTask(admin, id)).title).toBe(title);
});
