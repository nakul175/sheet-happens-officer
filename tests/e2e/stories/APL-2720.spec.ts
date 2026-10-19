// APL-2720 · Trash says how many days are left.
// AC1: the Time left cell reads "30 days left", "29 days left", "2 days left", "1 day left", "0 days left".
// AC2: the header stays "Time left", and sort, Restore and access stay as they are.
// The page is the real Trash screen. Tasks are created and deleted through the API.
// Ages other than a fresh delete are written to Task.deletedAt on the local database the app reads,
// then the page is loaded. The cell text is whatever that response paints. A remote database is not updated.
// Pam qa:TC: none on the issue. Password comes from SHO_QA_PASS. Names use ZZ-TEST. Projects are archived afterwards.
import { test, expect, zz, BASE_URL, type Page, type Who } from "../support";
import { newProject, newTask } from "../g2";

const DAY = 86400_000;
const HOUR = 3600_000;

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;

/** Same floor as listTrash: 30 minus whole days since deletedAt, and never below 0. */
const words = (daysLeft: number) => `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;

// Pam's live seed: 0 days, under 1 day, 1, 28, 29, under 30, and 30 days.
const AGES: { label: string; age: number; daysLeft: number }[] = [
  { label: "just now", age: HOUR, daysLeft: 30 },
  { label: "under a day", age: DAY - HOUR, daysLeft: 30 },
  { label: "one day", age: DAY + HOUR, daysLeft: 29 },
  { label: "twenty eight", age: 28 * DAY + HOUR, daysLeft: 2 },
  { label: "twenty nine", age: 29 * DAY + HOUR, daysLeft: 1 },
  { label: "under thirty", age: 30 * DAY - HOUR, daysLeft: 1 },
  { label: "thirty", age: 30 * DAY + HOUR, daysLeft: 0 },
];

test.beforeAll(() => {
  test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
});

function hostOf(raw: string) {
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw.replace(/^postgres(?:ql)?:/i, "http:") : raw;
    return new URL(withScheme).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** True only when the app and DATABASE_URL are both on this machine. A remote host is refused. */
function localDatabase() {
  const local = (host: string) => host === "localhost" || host === "127.0.0.1";
  return local(hostOf(BASE_URL)) && local(hostOf(process.env.DATABASE_URL ?? ""));
}

const NEEDS_LOCAL = "Days other than a fresh delete need deletedAt moved on the local database the app is reading. A remote database is left unchanged.";

async function openTrash(page: Page, projectId: string, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(`/projects/${projectId}/trash`);
}

function row(page: Page, title: string) {
  return page.locator("tbody tr").filter({ has: page.getByText(title, { exact: true }) });
}

async function ageDeletedAt(rows: { id: string; age: number }[]) {
  const { PrismaClient } = await import("../../../src/generated/prisma/client");
  const db = new PrismaClient();
  const now = Date.now();
  try {
    for (const row of rows) {
      await db.task.update({ where: { id: row.id }, data: { deletedAt: new Date(now - row.age) } });
    }
  } finally {
    await db.$disconnect();
  }
}

async function trashItem(who: Who, projectId: string, title: string) {
  const id = await newTask(who, projectId, { title });
  expect((await who.api.del(`/api/tasks/${id}`)).status).toBe(204);
  return id;
}

for (const viewport of VIEWPORTS) {
  const size = `${viewport.width}x${viewport.height}`;

  test(`qa:TC missing AC1@v1.0: Time left reads 30 days left at ${size}`, async ({ admin, later }) => {
    test.info().annotations.push({ type: "qa:TC", description: "missing" });
    const project = await newProject(admin, later, { label: `2720 fresh ${size}` });
    const title = zz("fresh");
    await trashItem(admin, project.id, title);
    await openTrash(admin.page, project.id, viewport);
    const cell = row(admin.page, title).locator("td[data-label='Time left']");
    await expect(cell).toHaveCount(1);
    await expect(cell).toBeVisible();
    await expect(cell).toHaveText(words(30));
    await expect(cell).toHaveAttribute("data-label", "Time left");
  });

  test(`qa:TC missing AC1@v1.0: Time left reads 30, 29, 2, 1 and 0 days left at ${size}`, async ({ admin, later }) => {
    test.info().annotations.push({ type: "qa:TC", description: "missing" });
    test.skip(!localDatabase(), NEEDS_LOCAL);
    const project = await newProject(admin, later, { label: `2720 ages ${size}` });
    const seeded: { label: string; age: number; daysLeft: number; id: string; title: string; text: string }[] = [];
    for (const age of AGES) {
      const title = zz(age.label);
      const id = await trashItem(admin, project.id, title);
      seeded.push({ ...age, id, title, text: words(age.daysLeft) });
    }
    await ageDeletedAt(seeded);
    const listed = (await admin.api.get(`/api/projects/${project.id}/trash`)).json.items as { id: string; daysLeft: number }[];
    expect(listed.map((item) => item.id)).toEqual(seeded.map((item) => item.id));
    for (const item of seeded) {
      expect(listed.find((row) => row.id === item.id)?.daysLeft, item.title).toBe(item.daysLeft);
    }
    await openTrash(admin.page, project.id, viewport);
    const cells = admin.page.locator("tbody td[data-label='Time left']");
    await expect(cells).toHaveCount(seeded.length);
    await expect(cells).toHaveText(seeded.map((item) => item.text));
    for (let i = 0; i < seeded.length; i++) {
      await expect(cells.nth(i)).toBeVisible();
      await expect(cells.nth(i)).toHaveAttribute("data-label", "Time left");
      await expect(row(admin.page, seeded[i].title)).toHaveCount(1);
    }
  });

  test(`qa:TC missing AC2@v1.0: keeps the Time left header, deletedAt order, and Restore at ${size}`, async ({ admin, later }) => {
    test.info().annotations.push({ type: "qa:TC", description: "missing" });
    const project = await newProject(admin, later, { label: `2720 order ${size}` });
    await openTrash(admin.page, project.id, viewport);
    await expect(admin.page.getByText("Trash is empty.")).toBeVisible();
    await expect(admin.page.getByText("Tasks are kept for 30 days, then removed for good.")).toBeVisible();

    const titles = [zz("oldest"), zz("middle"), zz("newest")];
    const ids: string[] = [];
    for (const title of titles) ids.push(await trashItem(admin, project.id, title));
    await openTrash(admin.page, project.id, viewport);

    const head = admin.page.locator("thead");
    await expect(head.locator("th")).toHaveText(["Item", "Deleted by", "Deleted", "Time left", ""]);
    if (viewport.width >= 1024) await expect(head).toBeVisible();
    else await expect(head).toBeHidden();

    const shown = [...titles].reverse();
    const itemCells = admin.page.locator("tbody td[data-label='Item']");
    const timeCells = admin.page.locator("tbody td[data-label='Time left']");
    await expect(itemCells).toHaveText(shown);
    await expect(timeCells).toHaveText(shown.map(() => words(30)));
    for (let i = 0; i < shown.length; i++) await expect(timeCells.nth(i)).toBeVisible();
    await expect(admin.page.getByRole("button", { name: "Restore" })).toHaveCount(shown.length);

    const newest = row(admin.page, shown[0]);
    await expect(newest).toHaveCount(1);
    await newest.getByRole("button", { name: "Restore" }).click();
    await expect.poll(async () => (await admin.api.get(`/api/tasks/${ids[2]}`)).status).toBe(200);
    await expect(newest).toHaveCount(0);
    await expect(admin.page.getByRole("button", { name: "Restore" })).toHaveCount(shown.length - 1);

    expect((await admin.api.post(`/api/projects/${project.id}/archive`)).status).toBe(200);
    await admin.page.reload();
    await expect(head.locator("th")).toHaveText(["Item", "Deleted by", "Deleted", "Time left", ""]);
    await expect(admin.page.getByRole("button", { name: "Restore" })).toHaveCount(0);
    await expect(row(admin.page, shown[1]).locator("td[data-label='Time left']")).toHaveText(words(30));
  });

  test(`qa:TC missing AC2@v1.0: hides Restore from an Editor and a Viewer at ${size}`, async ({ admin, member, later }) => {
    test.info().annotations.push({ type: "qa:TC", description: "missing" });
    const project = await newProject(admin, later, {
      label: `2720 access ${size}`,
      members: [{ who: member, role: "EDITOR" }],
    });
    later(() => admin.api.del(`/api/projects/${project.id}/members/${member.user.id}?handoverTo=${admin.user.id}`));
    const title = zz("seen");
    const id = await trashItem(admin, project.id, title);
    for (const role of ["EDITOR", "VIEWER"] as const) {
      if (role === "VIEWER") {
        expect((await admin.api.patch(`/api/projects/${project.id}/members/${member.user.id}`, { role })).status).toBe(200);
      }
      await openTrash(member.page, project.id, viewport);
      const cell = row(member.page, title).locator("td[data-label='Time left']");
      await expect(cell).toHaveCount(1);
      await expect(cell).toBeVisible();
      await expect(cell).toHaveText(words(30));
      await expect(member.page.locator("thead th")).toHaveText(["Item", "Deleted by", "Deleted", "Time left", ""]);
      await expect(member.page.getByRole("button", { name: "Restore" })).toHaveCount(0);
      expect((await member.api.post(`/api/tasks/${id}/restore`)).status, role).toBe(403);
    }
  });
}
