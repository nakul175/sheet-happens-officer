// Explicit owned-local acceptance: never discovered by the staging story config.
import { test, expect, zz, BASE_URL } from "../support";
import { localPgPool, schemaFromDatabaseUrl } from "../helpers/local-db-pool";
import { getTask, newProject, newTask, type Who } from "../g2";
import { activity, editTask } from "../helpers/claude-a";
import { activityRow } from "../helpers/screen-row";
const reviewOf = async (who: Who) => (await who.api.get("/api/review")).json as { ideas: {id:string;canEdit:boolean}[] };
test("APL-2505 > AC6: an action older than 30 days cannot be undone and says Too old to undo", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await newProject(admin, later, { label: "undo aged" });
  const title = zz("aged before");
  const id = await newTask(admin, p.id, { title });
  const edited = await editTask(admin, id, { title: zz("aged after") });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);
  const undoId = edited.headers["x-undo-id"];
  expect(undoId).toBeTruthy();
  expect((await activity(admin, p.id)).find((row) => row.id === undoId)?.undo).toBe("available");

  const database = process.env.DATABASE_URL;
  const schema = database ? schemaFromDatabaseUrl(database) : undefined;
  expect(["127.0.0.1", "localhost"]).toContain(new URL(BASE_URL).hostname);
  expect(schema).toMatch(/^sho_[a-z0-9_]+$/);
  expect(process.env.SHO_OWNED_TEST_SCHEMA).toBe(schema);
  const pool = localPgPool(database);
  let original: Date | undefined;
  try {
    const actor = await pool.query('SELECT email FROM "User" WHERE id=$1', [admin.user.id]);
    expect(actor.rows[0]?.email).toBe(admin.user.email);
    const row = await pool.query('SELECT "createdAt" FROM "ActionLog" WHERE id=$1 AND "actorId"=$2', [undoId, admin.user.id]);
    expect(row.rowCount).toBe(1);
    original = row.rows[0].createdAt;
    const aged = await pool.query(`UPDATE "ActionLog" SET "createdAt" = NOW() - INTERVAL '31 days' WHERE id=$1 AND "actorId"=$2`, [undoId, admin.user.id]);
    expect(aged.rowCount).toBe(1);
    expect((await activity(admin, p.id)).find((row) => row.id === undoId)?.undo).toBe("too_old");
    const refused = await admin.api.post(`/api/actions/${undoId}/undo`, {});
    expect(refused.status, JSON.stringify(refused.json)).toBe(409);
    expect(refused.json.error).toBe("Too old to undo");
    expect(refused.json.tooOld).toBe(true);
    await admin.page.goto(`/projects/${p.id}/activity`);
    const line = activityRow(admin.page, `renamed "${zz("aged before")}"`);
    await expect(line).toHaveCount(1);
    await expect(line.getByText("Too old to undo")).toBeVisible();
    await expect(line.getByRole("button", { name: "Undo" })).toHaveCount(0);
    expect((await getTask(admin, id)).title).toBe(zz("aged after"));
  } finally {
    if (original) {
      const restored = await pool.query('UPDATE "ActionLog" SET "createdAt"=$1 WHERE id=$2 AND "actorId"=$3', [original, undoId, admin.user.id]);
      expect(restored.rowCount).toBe(1);
    }
    await pool.end();
  }
});

test("AC4: an owned idea crossing 30 days appears with its Convert and Drop controls", async ({ admin, later }) => {
  const database = process.env.DATABASE_URL;
  const schema = database ? schemaFromDatabaseUrl(database) : undefined;
  expect(["127.0.0.1", "localhost"]).toContain(new URL(BASE_URL).hostname);
  expect(schema).toMatch(/^sho_[a-z0-9_]+$/);
  expect(process.env.SHO_OWNED_TEST_SCHEMA).toBe(schema);
  const project = await newProject(admin, later, { label: "aged review idea" });
  const title = zz("aged review idea");
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id });
  expect((await admin.api.post(`/api/tasks/${id}/idea`, { isIdea: true })).status).toBe(200);
  expect((await reviewOf(admin)).ideas.some(row => row.id === id)).toBe(false);
  const pool = localPgPool(database);
  let original: Date | undefined;
  try {
    const actor = await pool.query('SELECT email FROM "User" WHERE id=$1', [admin.user.id]);
    expect(actor.rows[0]?.email).toBe(admin.user.email);
    const row = await pool.query('SELECT "createdAt" FROM "Task" WHERE id=$1 AND "projectId"=$2', [id, project.id]);
    expect(row.rowCount).toBe(1);
    original = row.rows[0].createdAt;
    expect((await pool.query(`UPDATE "Task" SET "createdAt"=NOW()-INTERVAL '31 days' WHERE id=$1 AND "projectId"=$2`, [id, project.id])).rowCount).toBe(1);
    expect((await reviewOf(admin)).ideas.find(row => row.id === id)?.canEdit).toBe(true);
    await admin.page.goto("/review");
    const region = admin.page.getByRole("region", { name: "Ideas older than 30 days" });
    await expect(region.getByText(title, { exact: true })).toBeVisible();
    // This owned fixture is the only unarchived old idea created by this case; controls are asserted on its row.
    const link = region.getByRole("link", { name: title, exact: true });
    const item = link.locator("../..");
    await expect(item.getByRole("button", { name: "Convert to deal" })).toBeVisible();
    await expect(item.getByRole("button", { name: "Drop" })).toBeVisible();
  } finally {
    if (original) expect((await pool.query('UPDATE "Task" SET "createdAt"=$1 WHERE id=$2 AND "projectId"=$3', [original, id, project.id])).rowCount).toBe(1);
    await pool.end();
  }
});
