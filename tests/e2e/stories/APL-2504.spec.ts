// APL-2504 · SHO-US-6.3 Action log with before-state
// Acceptance criteria: AC1 one row per write with who/what/before/after, AC2 "via concierge" tag, AC3 visibility by role,
// AC4 Activity screen newest first, AC5 12-month retention, AC6 "Too old to undo" after 30 days.
// AC4 text says an Editor must not reach the screen; SHO-US-14.14 later let Editors see rows for their own tasks. The tests follow
// the live 14.14 behaviour (Editor: own tasks only; Viewer: refused) and say so.
// Data: every project and task is named "ZZ-TEST ..."; projects are archived afterwards.
import { test, expect, zz, type Who } from "../support";
import { cleanChat, patchCurrent } from "../helpers/jim-http";
import { ask, cardOf } from "../helpers/jim-concierge";
import { localSql, runLocalJob, sourceOf, sqlId } from "../helpers/local-clock";
import { activityRow } from "../helpers/screen-row";

test.beforeAll(() => {
  test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
});

async function proj(admin: Who, label: string, later: (f: () => Promise<unknown>) => void, leaderId?: string) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: leaderId ?? admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return id;
}
const mk = async (who: Who, p: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await who.api.post(`/api/projects/${p}/tasks`, { title, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
};
const rows = async (who: Who, p: string) => (await who.api.get(`/api/projects/${p}/activity`)).json.items as { what: string; who: string; via: string; undo: string }[];

// qa:TC missing
test("AC1: each write leaves one row with who, what, and the before and after values", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "log-rows", later);
  const t = await mk(admin, p, zz("old name"), { dueDate: "2026-11-03" });
  expect((await patchCurrent(admin, t, { priority: "HIGH" })).status).toBe(200);
  expect((await admin.api.del(`/api/tasks/${t}`)).status).toBe(204);
  const items = await rows(admin, p);
  const text = items.map((i) => i.what);
  expect(text.some((w) => /created the project/.test(w))).toBe(true);
  expect(text.some((w) => /added ".*" to To do/.test(w))).toBe(true);
  expect(text.filter((w) => /changed priority from Medium to High/.test(w))).toHaveLength(1); // before and after
  expect(text.filter((w) => /moved ".*" to Trash/.test(w))).toHaveLength(1);
  for (const i of items) expect(i.who).toBe(admin.user.name);
});

// qa:TC missing
test("APL-2504 AC2: a change made on screen is not tagged via concierge", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "log-via", later);
  const t = await mk(admin, p, zz("screen write"), { dueDate: "2026-11-03" });
  expect((await patchCurrent(admin, t, { priority: "HIGH" })).status).toBe(200);
  const screen = (await rows(admin, p)).find((r) => /changed priority/.test(r.what));
  expect(screen?.via).toBe("screen");
  await admin.page.goto(`/projects/${p}/activity`);
  await expect(activityRow(admin.page, "changed priority").getByText("via concierge")).toHaveCount(0);
});

// qa:TC missing
test("APL-2504 AC2: a change made through the concierge carries a via concierge tag @manual", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const state = await admin.api.get("/api/concierge/state");
  const code = (state.json.disabled as { code?: string } | undefined)?.code;
  const modelCan = state.status === 200 && !code;
  test.skip(!modelCan, `APL-2504: the concierge cannot run in this environment${code ? ` (${code})` : ""}, so a via concierge row is not invented.`);
  await cleanChat(admin, later);
  const p = await proj(admin, "log-via-live", later);
  const title = zz("concierge priority");
  await mk(admin, p, title, { dueDate: "2026-11-03" });
  const asked = await ask(admin, `Set the priority of "${title}" to Low.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.status, "the concierge offers a confirm card before it writes").toBe("PENDING");
  const confirmed = await admin.api.post(`/api/concierge/cards/${card!.id}/confirm`, {});
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  const via = (await rows(admin, p)).find((r) => r.via === "concierge" && /priority/.test(r.what));
  expect(via, "the concierge row is tagged").toBeTruthy();
  await admin.page.goto(`/projects/${p}/activity`);
  await expect(activityRow(admin.page, "priority").getByText("via concierge", { exact: true })).toBeVisible();
});

// qa:TC missing
test("APL-2504 AC2: the via concierge label comes from the concierge channel @static", async () => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  expect(sourceOf("src/lib/feed.ts", "via: r.channel")).toContain('r.channel === "CONCIERGE" ? "concierge" : "screen"');
  expect(sourceOf("src/app/(app)/projects/[id]/activity/Activity.tsx", 'r.via === "concierge"')).toContain("via concierge");
  expect(sourceOf("src/lib/concierge/cards.ts", 'channel: "CONCIERGE"')).toContain('channel: "CONCIERGE"');
});

// qa:TC missing
test("AC3: a Member cannot read another project's rows; a Leader reads their own project's rows; an Admin reads all", async ({ admin, member, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const mine = await proj(admin, "log-led", later, member.user.id); // the member leads this project
  const other = await proj(admin, "log-other", later); // the member is not in this one
  await mk(admin, mine, zz("led task"), { dueDate: "2026-11-03" });
  await mk(admin, other, zz("other task"), { dueDate: "2026-11-03" });
  expect((await member.api.get(`/api/projects/${mine}/activity`)).status).toBe(200);
  expect((await rows(member, mine)).some((r) => r.what.includes(zz("led task")))).toBe(true);
  expect((await member.api.get(`/api/projects/${other}/activity`)).status).toBe(404);
  expect((await admin.api.get(`/api/projects/${other}/activity`)).status).toBe(200);
  expect((await admin.api.get(`/api/projects/${mine}/activity`)).status).toBe(200);
});

// qa:TC missing
test("AC4: a Leader or Admin opens Activity and sees the project's rows newest first; a Viewer is refused", async ({ admin, member, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "log-screen", later);
  const t = await mk(admin, p, zz("screen task"), { dueDate: "2026-11-03" });
  expect((await patchCurrent(admin, t, { priority: "HIGH" })).status).toBe(200);
  await admin.page.goto(`/projects/${p}/activity`);
  // SHO-US-14.14 turned the When/Who/What/How table into one sentence per row (who, what, local date, channel chip, Undo).
  const changed = `${admin.user.name} changed priority from Medium to High`;
  const main = admin.page.getByRole("main");
  await expect(main.getByText(changed)).toHaveCount(1);
  const body = await main.innerText();
  expect(body.indexOf(changed), "newest row").toBeLessThan(body.lastIndexOf("created the project"));
  expect(body).toMatch(/\d{1,2} \w{3}, /); // local date and time
  // Viewer: no Activity link and the API refuses
  expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  await member.page.goto(`/projects/${p}`);
  await expect(member.page.getByRole("tab", { name: "List" })).toBeVisible();
  await expect(member.page.getByRole("link", { name: "Activity" })).toHaveCount(0);
  expect((await member.api.get(`/api/projects/${p}/activity`)).status).toBe(403);
  await member.page.goto(`/projects/${p}/activity`);
  await expect(member.page.getByText("Only people who work on this project can see Activity.")).toBeVisible();
});

// qa:TC missing
test("AC4 (Editor, per SHO-US-14.14): an Editor sees only rows about their own tasks", async ({ admin, member, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "log-editor", later);
  expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  await mk(admin, p, zz("leader's task"), { dueDate: "2026-11-03" });
  await mk(member, p, zz("editor's task"), { dueDate: "2026-11-03" });
  const seen = (await rows(member, p)).map((r) => r.what).join(" | ");
  expect(seen).toContain(zz("editor's task"));
  expect(seen).not.toContain(zz("leader's task"));
});

// qa:TC missing
test("APL-2504 AC5: rows older than 12 months are removed and a newer row stays", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "log-year", later);
  const t = await mk(admin, p, zz("kept row"), { dueDate: "2026-11-03" });
  const items = (await admin.api.get(`/api/projects/${p}/activity`)).json.items as { id: string; what: string }[];
  const created = items.find((i) => i.what.includes(zz("kept row")) && /added/.test(i.what));
  expect(created, "the new row is still in the log").toBeTruthy();
  expect((await patchCurrent(admin, t, { priority: "HIGH" })).status).toBe(200);

  if (localSql(`UPDATE "ActionLog" SET "createdAt" = NOW() - INTERVAL '13 months' WHERE id = '${sqlId(created!.id)}'`)) {
    const res = await runLocalJob(admin.page.request, "purge-old");
    expect(res!.status(), await res!.text()).toBe(200);
    const left = (await admin.api.get(`/api/projects/${p}/activity`)).json.items as { id: string; what: string }[];
    expect(left.some((i) => i.id === created!.id), "a row older than 12 months is gone").toBe(false);
    expect(left.some((i) => /changed priority/.test(i.what)), "a newer row stays").toBe(true);
  }
});

// qa:TC missing
test("APL-2504 AC5: action rows are kept for 12 months in the source @static", async () => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  expect(sourceOf("src/lib/feed.ts", "const LOG_MONTHS")).toContain("const LOG_MONTHS = 12");
  const fn = sourceOf("src/lib/feed.ts", "export async function purgeOld");
  expect(fn).toContain("cut.setMonth(cut.getMonth() - LOG_MONTHS)");
  expect(fn).toContain("actionLog.deleteMany");
  expect(fn).toContain("createdAt: { lt: cut }");
});

// qa:TC missing
test("APL-2504 AC6: Undo is disabled with Too old to undo after 30 days", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "log-old", later);
  const t = await mk(admin, p, zz("age me"), { dueDate: "2026-11-03" });
  expect((await patchCurrent(admin, t, { priority: "LOW" })).status).toBe(200);
  const items = (await admin.api.get(`/api/projects/${p}/activity`)).json.items as { id: string; what: string; undo: string }[];
  const row = items.find((i) => /changed priority/.test(i.what));
  expect(row?.undo).toBe("available");

  if (localSql(`UPDATE "ActionLog" SET "createdAt" = NOW() - INTERVAL '31 days' WHERE id = '${sqlId(row!.id)}'`)) {
    const aged = ((await admin.api.get(`/api/projects/${p}/activity`)).json.items as { id: string; undo: string }[]).find((i) => i.id === row!.id);
    expect(aged?.undo).toBe("too_old");
    const refused = await admin.api.post(`/api/actions/${row!.id}/undo`, {});
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("Too old to undo");
    await admin.page.goto(`/projects/${p}/activity`);
    const line = activityRow(admin.page, "changed priority", zz("age me"));
    await expect(line).toHaveCount(1);
    await expect(line.getByText("Too old to undo")).toBeVisible();
    await expect(line.getByRole("button", { name: "Undo" })).toHaveCount(0);
  }
});

// qa:TC missing
test("APL-2504 AC6: Undo is refused after 30 days in the source @static", async () => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  expect(sourceOf("src/lib/undoable.ts", "export const UNDO_DAYS")).toContain("export const UNDO_DAYS = 30;");
  expect(sourceOf("src/lib/undo.ts", 'throw bad("Too old to undo"')).toContain("tooOld: true");
  expect(sourceOf("src/lib/feed.ts", "isTooOldToUndo(r.createdAt)")).toContain('"too_old"');
  expect(sourceOf("src/app/(app)/projects/[id]/activity/Activity.tsx", '{showTooOld(r, pr.data?.project.role)')).toContain("Too old to undo");
});
