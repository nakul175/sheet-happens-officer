// APL-2691: Move to Won / Lost shows why it is refused (APL-2529 AC6).
// One test per acceptance criterion. ZZ-TEST deals and organisations are archived afterwards.
// The Super Admin acts as Leader. workers is 1 in playwright.config.ts. Traces stay off.
// Pam's ids sit in the title, next to the acceptance-criteria tag, the same way the other story specs do.
// A missing SHO_QA_PASS skips the file, like every story spec in staging-e2e.yml. The `admin` fixture does not sign in
// with SHO_QA_PASS: it uses login("ADMIN") (SHARD_* in a CI shard, otherwise SHO_ADMIN_EMAIL / SHO_ADMIN_PASS). beforeAll
// checks that account too, so a missing one fails once with its variable names. No password is written here.
import { test, expect, zz, login } from "../support";
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
    ids.push(await newTask(admin, dealId, { title }));
    titles.push(title);
  }
  return { titles, ids };
}

test.beforeAll(() => {
  test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared QA password; story specs skip without it).");
  // Throws "Set SHO_ADMIN_EMAIL ..." (or _PASS) when the account the admin fixture signs in with is missing.
  login("ADMIN");
});

test.describe("qa:TC missing APL-2691", { tag: "@APL-2691" }, () => {
  test.describe.configure({ timeout: 180_000 });

  test(
    "@APL-2691 qa:TC-APL2691-8d4e9e0b@v1 AC1: the Move to Won dialog shows an alert containing 21 within 10s, lists the first 20 open tasks, and nothing is closed or archived",
    { tag: ["@APL-2691", "@AC1"] },
    async ({ admin, later }: { admin: Who; later: Later }) => {
      const step = zz("won step");
      const deal = await makeDeal(admin, later, "2691 won", step);
      const next = (await projectOf(admin, deal.id)).deal.nextStep!;
      const made = await openTasks(admin, deal.id, next, 20);

      await admin.page.goto(`/projects/${deal.id}`);
      // Read the order the person actually sees, before the dialog hides the task rows.
      const titlePattern = new RegExp(made.titles.map(title => title.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&")).join("|"));
      const taskRows = admin.page.getByRole("button").filter({ hasText: titlePattern });
      await expect(taskRows).toHaveCount(21);
      const displayedTitles = (await taskRows.allTextContents()).map(text => {
        const matches = made.titles.filter(title => text.includes(title));
        expect(matches).toHaveLength(1);
        return matches[0];
      });
      await admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Won", exact: true }).click();
      const dialog = admin.page.getByRole("dialog", { name: "Move to Won" });
      const alert = dialog.getByRole("alert");
      await expect(alert).toContainText("21 open tasks", { timeout: WITHIN });
      await dialog.getByRole("button", { name: "Move deal" }).click();
      await expect(alert).toContainText("21 open tasks", { timeout: WITHIN });
      const shown = (await dialog.getByRole("link").allTextContents()).map((t: string) => t.trim());
      expect(shown).toHaveLength(20);
      expect(shown).toEqual(displayedTitles.slice(0, 20));
      expect(made.titles.filter((t) => !shown.includes(t))).toEqual([displayedTitles[20]]);

      const after = await projectOf(admin, deal.id);
      expect(after.deal.stage.name).toBe("Lead");
      expect(after.archived).toBe(false);
      for (const id of made.ids) expect((await getTask(admin, id)).completedAt).toBeNull();
      await dialog.getByRole("button", { name: "Cancel" }).click();
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
    "@APL-2691 qa:TC-APL2691-6ec60bba@v1 AC3: POST /api/projects/{id}/stage with Won still returns 409 with openTasks 21",
    { tag: ["@APL-2691", "@AC3"] },
    async ({ admin, later }: { admin: Who; later: Later }) => {
      const step = zz("api step");
      const deal = await makeDeal(admin, later, "2691 api", step);
      const next = (await projectOf(admin, deal.id)).deal.nextStep!;
      await openTasks(admin, deal.id, next, 20);
      const won = deal.pro.stages.find((s) => s.name === "Won");
      expect(won, "Won stage").toBeTruthy();

      const blocked = await admin.api.post(`/api/projects/${deal.id}/stage`, { stageId: won!.id });
      expect(blocked.status).toBe(409);
      expect(blocked.json.openTasks).toBe(21);
      expect(blocked.json.error).toContain("21 tasks are still open");
      const after = await projectOf(admin, deal.id);
      expect(after.deal.stage.name).toBe("Lead");
      expect(after.archived).toBe(false);
      expect((await getTask(admin, next.id)).completedAt).toBeNull();
    },
  );
});
