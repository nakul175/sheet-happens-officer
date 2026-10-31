// SHO-2907: migrate APL-2691 onto the live NJ-refined SHO-3050 contract.
// Won retains operational tasks; Lost preserves its refusal and ordered task list.
// The obsolete Won409 assertions are superseded, not skipped. No product behavior changes.
// One test per acceptance criterion. ZZ-TEST deals and organisations are archived afterwards.
// The Super Admin acts as Leader. workers is 1 in playwright.config.ts. Traces stay off.
// Pam's ids sit in the title, next to the acceptance-criteria tag, the same way the other story specs do.
// A missing SHO_QA_PASS skips the file, like every story spec in staging-e2e.yml. The `admin` fixture does not sign in
// with SHO_QA_PASS: it uses login("ADMIN") (SHARD_* in a CI shard, otherwise SHO_ADMIN_EMAIL / SHO_ADMIN_PASS). beforeAll
// checks that account too, so a missing one fails once with its variable names. No password is written here.
import { expect, zz, login } from "../support";
import { test, local2691 } from "../helpers/2691-admin";
import { getTask, newTask, ymd, type Who } from "../g2";

type Later = (fn: () => Promise<unknown>) => void;
type Stage = { id: string; name: string; category: string };
type Pipe = { id: string; key: string; name: string; stages: Stage[] };

const WITHIN = 10_000;

async function proPipeline(who: Who) {
  const r = await who.api.get("/api/deals/pipelines");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const pro = (r.json.pipelines as Pipe[]).find((p) => p.key === "DEAL_PROACTIVE");
  expect(pro, "Proactive pipeline").toBeTruthy();
  return pro!;
}

async function makeDeal(admin: Who, later: Later, label: string, step: string) {
  const pro = await proPipeline(admin);
  const org = await admin.api.post("/api/orgs", { name: zz(`org ${label}`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const d = await admin.api.post("/api/deals", {
    name: zz(`deal ${label}`), organisationId: orgId, pipelineId: pro.id, leaderId: admin.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: step, dueDate: ymd(6) },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return { id, step, pro };
}

const projectOf = async (who: Who, id: string) => (await who.api.get(`/api/projects/${id}`)).json.project as {
  archived: boolean;
  deal: { stage: { name: string }; nextStep: { id: string; title: string } | null };
};

/** The next step plus `extra` more open tasks. Returns every title and id, next step first. */
async function openTasks(admin: Who, dealId: string, step: { id: string; title: string }, extra: number) {
  const titles = [step.title];
  const ids = [step.id];
  for (let i = 0; i < extra; i++) {
    const title = zz(`open ${i}`);
    ids.push(await newTask(admin, dealId, { title, dueDate: ymd(6), assigneeId: admin.user.id }));
    titles.push(title);
  }
  return { titles, ids };
}

/** Snapshot actual task business state; project stage may legitimately change. */
async function taskStates(who: Who, ids: string[]) {
  return Promise.all(ids.map(async id => { const t = await getTask(who, id); return {
    id: t.id, title: t.title, assignee: t.assignee, collaborators: t.collaborators,
    dueDate: t.dueDate, completedAt: t.completedAt, deletedAt: t.deletedAt,
    blocked: t.blocked, blockedReason: t.blockedReason, updatedAt: t.updatedAt,
  }; }));
}

test.beforeAll(() => {
  test.skip(!local2691 && !process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared QA password; story specs skip without it).");
  // Throws "Set SHO_ADMIN_EMAIL ..." (or _PASS) when the account the admin fixture signs in with is missing.
  if (!local2691) login("ADMIN");
});

test.describe("qa:TC missing APL-2691", { tag: "@APL-2691" }, () => {
  test.describe.configure({ timeout: 180_000 });

  test(
    "@APL-2691 qa:TC missing AC1 v2 (SHO-3050): UI moves to Won with21 open tasks and preserves every task",
    { tag: ["@APL-2691", "@AC1"] },
    async ({ admin, later }: { admin: Who; later: Later }) => {
      const deal = await makeDeal(admin, later, "2691 won", zz("won step"));
      const next = (await projectOf(admin, deal.id)).deal.nextStep!;
      const made = await openTasks(admin, deal.id, next, 20);
      const before = await taskStates(admin, made.ids);
      await admin.page.goto(`/projects/${deal.id}`);
      await admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Won", exact: true }).click();
      const dialog = admin.page.getByRole("dialog", { name: "Move to Won" });
      await expect(dialog).toBeVisible(); await expect(dialog.getByRole("alert")).toHaveCount(0);
      await dialog.getByRole("button", { name: "Move deal" }).click();
      await expect(dialog).toHaveCount(0);
      const after = await projectOf(admin, deal.id);
      expect(after.deal.stage.name).toBe("Won"); expect(after.archived).toBe(false);
      expect(after.deal.nextStep).toBeNull();
      expect(await taskStates(admin, made.ids)).toEqual(before);
    },
  );

  test(
    '@APL-2691 qa:TC-APL2691-c3d4c477@v1 AC2: Move to Lost says "1 open task" and lists that task',
    { tag: ["@APL-2691", "@AC2"] },
    async ({ admin, later }: { admin: Who; later: Later }) => {
      const step = zz("lost step");
      const deal = await makeDeal(admin, later, "2691 lost", step);
      const next = (await projectOf(admin, deal.id)).deal.nextStep!;

      await admin.page.goto(`/projects/${deal.id}`);
      await admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Lost", exact: true }).click();
      const dialog = admin.page.getByRole("dialog", { name: "Move to Lost" });
      await dialog.getByLabel("Reason (required)").fill("ZZ-TEST lost");
      await dialog.getByRole("button", { name: "Move deal" }).click();
      const alert = dialog.getByRole("alert");
      await expect(alert).toContainText("1 open task", { timeout: WITHIN });
      await expect(alert).not.toContainText("open tasks");
      await expect(dialog.getByRole("link", { name: step })).toBeVisible();

      const after = await projectOf(admin, deal.id);
      expect(after.deal.stage.name).toBe("Lead");
      expect(after.archived).toBe(false);
      expect((await getTask(admin, next.id)).completedAt).toBeNull();
      await dialog.getByRole("button", { name: "Cancel" }).click();
    },
  );

  test(
    "@APL-2691 qa:TC missing AC3 v2 (SHO-3050): API Won succeeds with21 open tasks, Lost still returns409",
    { tag: ["@APL-2691", "@AC3"] },
    async ({ admin, later }: { admin: Who; later: Later }) => {
      const deal = await makeDeal(admin, later, "2691 API", zz("API step"));
      const next = (await projectOf(admin, deal.id)).deal.nextStep!;
      const made = await openTasks(admin, deal.id, next, 20), before = await taskStates(admin, made.ids);
      const won = deal.pro.stages.find(s => s.name === "Won")!, lost = deal.pro.stages.find(s => s.name === "Lost")!;
      const refused = await admin.api.post(`/api/projects/${deal.id}/stage`, { stageId: lost.id, reason: "ZZ-TEST refusal" });
      expect(refused.status).toBe(409); expect(refused.json.openTasks).toBe(21); expect(refused.json.tasks).toHaveLength(20);
      expect((await projectOf(admin, deal.id)).deal.stage.name).toBe("Lead");
      expect(await taskStates(admin, made.ids)).toEqual(before);
      const moved = await admin.api.post(`/api/projects/${deal.id}/stage`, { stageId: won.id }); expect(moved.status).toBe(200);
      const after = await projectOf(admin, deal.id); expect(after.deal.stage.name).toBe("Won"); expect(after.archived).toBe(false); expect(after.deal.nextStep).toBeNull();
      expect(await taskStates(admin, made.ids)).toEqual(before);
    },
  );

  test(
    "@APL-2691 qa:TC missing AC4: Lost preserves the21-task refusal and exact first20 task-page ordering",
    { tag: ["@APL-2691", "@AC4"] },
    async ({ admin, later }: { admin: Who; later: Later }) => {
      const deal = await makeDeal(admin, later, "2691 lost order", zz("lost order step"));
      const made = await openTasks(admin, deal.id, (await projectOf(admin, deal.id)).deal.nextStep!, 20);
      const before = await taskStates(admin, made.ids);
      await admin.page.goto(`/projects/${deal.id}`);
      const titlePattern = new RegExp(made.titles.map(title => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
      const taskRows = admin.page.getByRole("link").filter({ hasText: titlePattern }); await expect(taskRows).toHaveCount(21);
      const displayedTitles = (await taskRows.allTextContents()).map(text => { const matches = made.titles.filter(title => text.includes(title)); expect(matches).toHaveLength(1); return matches[0]; });
      await admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Lost", exact: true }).click();
      const dialog = admin.page.getByRole("dialog", { name: "Move to Lost" }), alert = dialog.getByRole("alert");
      await expect(alert).toContainText("21 open tasks", { timeout: WITHIN });
      const shown = (await dialog.getByRole("link").allTextContents()).map(t => t.trim());
      expect(shown).toHaveLength(20); expect(shown).toEqual(displayedTitles.slice(0,20)); expect(made.titles.filter(t => !shown.includes(t))).toEqual([displayedTitles[20]]);
      await dialog.getByLabel("Reason (required)").fill("ZZ-TEST retained safeguard"); await dialog.getByRole("button", { name: "Move deal" }).click();
      await expect(alert).toContainText("21 open tasks", { timeout: WITHIN });
      expect((await projectOf(admin, deal.id)).deal.stage.name).toBe("Lead"); expect(await taskStates(admin, made.ids)).toEqual(before);
      await dialog.getByRole("button", { name: "Cancel" }).click();
    },
  );
});
