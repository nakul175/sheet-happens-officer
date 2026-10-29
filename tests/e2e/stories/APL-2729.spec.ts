// APL-2729. Due-date reminders must not name a deal the reader may not see.
// workers=1. ZZ-TEST deals and nakul17+ aliases. The reminders job runs only on a local server.
// A remote host is refused so a shared staging database never gets a reminder sweep.
// gateFile() skips this file in beforeAll when SHO_QA_PASS is unset. Playwright then exits 0.
// No APL-2729 TC ids are in the register, so every title carries the literal token "qa:TC missing".
// Each test runs against the one server it is pointed at and checks what that CRM_VISIBLE mode requires. Nothing skips
// except the SHO_QA_PASS gate (gateFile) and the shared harness's guard that never runs the job against a remote host.
// Under off the deal API is closed, so no deal can be seeded. The off test checks every reminder the job just made
// opens for its reader (a deal task is "not found" for everyone under off) and that the ops reminder stays.
// The stored-row check for every mode, including off, is one server process per mode on the product branch (#92).
import { test, expect, zz } from "../support";
import { newProject, newTask, ymd, type Who } from "../g2";
import { createDeal, createOrg, dealBody, notices } from "../helpers/claude-a";
import { pipelines } from "../helpers/deal-board";
import { cast, gateFile, noSecret, QA_PASS, runLocalJob } from "../helpers/qa-alias";

gateFile();

type Mode = "all" | "admins" | "off";
type Item = { text: string; href: string | null };
type Fresh = Item & { createdAt: string };
type Later = (fn: () => Promise<unknown>) => void;
type World = {
  mode: Mode;
  member: Who;
  orgAdmin: Who;
  dealId: string;
  dealName: string;
  memberTitle: string;
  memberTaskId: string;
  adminTitle: string;
  adminTaskId: string;
  opsTitle: string;
  opsTaskId: string;
  jobAt: number;
};

const cleanup: (() => Promise<unknown>)[] = [];
const later: Later = (fn) => { cleanup.push(fn); };
let world: World | null = null;

function useWorld() {
  if (!world) throw new Error("The story setup did not run.");
  return world;
}

async function bell(who: Who): Promise<Item[]> {
  const rows = await notices(who);
  return rows.map((item) => ({ text: item.text, href: item.href ?? null }));
}

/** Due reminders made by this run's job (the server is local, so its clock is this one). */
async function freshDue(who: Who, since: number): Promise<Fresh[]> {
  const r = await who.api.get("/api/notifications?limit=200");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const items = (r.json.items ?? []) as Fresh[];
  return items.filter((item) => / is (due|overdue)/.test(item.text) && Date.parse(item.createdAt) >= since);
}

/** Every due reminder this run's job made for the reader opens for them. Under off a deal task is "not found" for everyone. */
async function assertFreshRemindersOpen(who: Who, w: World) {
  const fresh = await freshDue(who, w.jobAt);
  noSecret(JSON.stringify(fresh));
  for (const item of fresh) {
    expect(item.href, item.text).toMatch(/^\/tasks\/[\w-]+$/);
    const opened = await who.api.get(`/api${item.href}`);
    expect(opened.status, `${item.text} -> ${item.href}`).toBe(200);
  }
}

/** The CRM_VISIBLE mode this run checks, recorded on the test so a report says which mode passed. */
function useModeWorld() {
  const w = useWorld();
  test.info().annotations.push({ type: "CRM_VISIBLE", description: w.mode });
  return w;
}

/** Reminder copy only. Assignment notices from seeding are a different path. */
function dueItems(items: Item[]) {
  return items.filter((item) => / is (due|overdue)/.test(item.text));
}

async function readMode(member: Who, admin: Who): Promise<Mode> {
  const [asMember, asAdmin] = await Promise.all([
    member.api.get("/api/deals/pipelines"),
    admin.api.get("/api/deals/pipelines"),
  ]);
  if (asAdmin.status === 404) return "off";
  if (asMember.status === 404 && asAdmin.status === 200) return "admins";
  if (asMember.status === 200 && asAdmin.status === 200) return "all";
  throw new Error(`Could not read CRM mode (member ${asMember.status}, admin ${asAdmin.status}).`);
}

function assertNoDealReminder(items: Item[], w: World) {
  const due = dueItems(items);
  const body = JSON.stringify(due);
  for (const needle of [w.dealName, w.memberTitle, w.adminTitle, w.dealId, `/projects/${w.dealId}`, `/tasks/${w.memberTaskId}`, `/tasks/${w.adminTaskId}`]) {
    expect(body, needle).not.toContain(needle);
  }
}

function assertDealReminder(items: Item[], title: string, taskId: string) {
  const due = dueItems(items);
  expect(due).toContainEqual({ text: `"${title}" is due tomorrow.`, href: `/tasks/${taskId}` });
}

function assertOps(items: Item[], w: World) {
  expect(dueItems(items)).toContainEqual({ text: `"${w.opsTitle}" is due tomorrow.`, href: `/tasks/${w.opsTaskId}` });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  if (!QA_PASS) return;
  const { admin, people } = await cast(browser, later, ["remind member", "remind admin"]);
  const [member, orgAdmin] = people;
  const promoted = await admin.api.patch(`/api/team/${orgAdmin.user.id}`, { orgRole: "ADMIN" });
  expect(promoted.status, JSON.stringify(promoted.json)).toBe(200);
  const mode = await readMode(member, admin);
  // The non-deal task is seeded in every mode (AC3).
  const ops = await newProject(admin, later, { label: "ops", members: [{ who: member }, { who: orgAdmin }] });
  const opsTitle = zz("Ops check");
  const opsTaskId = await newTask(orgAdmin, ops.id, { title: opsTitle, assigneeId: member.user.id, dueDate: ymd(1) });
  // off closes the deal API, so no deal can be seeded; the off test checks what the job made instead.
  if (mode === "off") {
    const jobAt = Date.now() - 2_000;
    await runLocalJob("reminders");
    world = { mode, member, orgAdmin, dealId: "", dealName: "", memberTitle: "", memberTaskId: "", adminTitle: "", adminTaskId: "", opsTitle, opsTaskId, jobAt };
    return;
  }
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "Acme buyer");
  const dealName = zz("Acme renewal");
  const memberTitle = zz("Acme kickoff");
  const adminTitle = zz("Acme kickoff admin");
  const deal = await createDeal(admin, later, dealBody({
    name: dealName, organisationId: org.id, pipelineId: pipes.pro.id, leaderId: String(orgAdmin.user.id), step: zz("later step"), due: ymd(14),
  }));
  const added = await admin.api.post(`/api/projects/${deal.id}/members`, { userId: member.user.id, role: "EDITOR" });
  expect(added.status, JSON.stringify(added.json)).toBe(201);
  const memberTaskId = await newTask(orgAdmin, deal.id, { title: memberTitle, assigneeId: member.user.id, dueDate: ymd(1) });
  const adminTaskId = await newTask(orgAdmin, deal.id, { title: adminTitle, assigneeId: orgAdmin.user.id, dueDate: ymd(1) });
  const jobAt = Date.now() - 2_000;
  await runLocalJob("reminders");
  world = { mode, member, orgAdmin, dealId: deal.id, dealName, memberTitle, memberTaskId, adminTitle, adminTaskId, opsTitle, opsTaskId, jobAt };
});

test.afterAll(async () => {
  for (const fn of [...cleanup].reverse()) {
    try { await fn(); } catch { /* a ZZ-TEST row left behind is easier to find than a hidden cleanup error */ }
  }
});

test("qa:TC missing AC1 AC2: a member gets the deal reminder only while the CRM is visible to them", async () => {
  const w = useModeWorld();
  const items = await bell(w.member);
  noSecret(JSON.stringify(items));
  if (w.mode === "all") assertDealReminder(items, w.memberTitle, w.memberTaskId); // AC2: unchanged from main (unset reads as all)
  else if (w.mode === "admins") assertNoDealReminder(items, w); // AC1
  else await assertFreshRemindersOpen(w.member, w); // AC1 under off: no deal can be seeded, so nothing new may point at one
});

test("qa:TC missing AC1 AC2: an Admin keeps the deal reminder under all and admins, and off hides it", async () => {
  const w = useModeWorld();
  const items = await bell(w.orgAdmin);
  noSecret(JSON.stringify(items));
  if (w.mode === "off") await assertFreshRemindersOpen(w.orgAdmin, w); // AC1: off hides deals from Admins too
  else assertDealReminder(items, w.adminTitle, w.adminTaskId); // AC2
});

test("qa:TC missing AC3: the non-deal reminder is unchanged in every mode", async () => {
  const w = useModeWorld();
  const items = await bell(w.member);
  noSecret(JSON.stringify(items));
  assertOps(items, w);
});
