// APL-2729. Due-date reminders must not name a deal the reader may not see.
// workers=1. ZZ-TEST deals and nakul17+ aliases. The reminders job runs only on a local server.
// A remote host is refused so a shared staging database never gets a reminder sweep.
// gateFile() skips this file in beforeAll when SHO_QA_PASS is unset. Playwright then exits 0.
// Pam qa:TC: c2ee0001 (unset, same as all here), c2a11001 (all), c1a1d001 (admins member),
// c2ad0001 (admins admin), c1ff0001 (off), c30b5001 (ops check).
// The stored-row check for every mode, including off, is one server process per mode in
// tests/jobs-reminders-crm-server.test.ts on the product branch. That file also posts the job 40 times.
import { test, expect, zz } from "../support";
import { newProject, newTask, ymd, type Who } from "../g2";
import { createDeal, createOrg, dealBody, notices } from "../helpers/claude-a";
import { pipelines } from "../helpers/deal-board";
import { cast, gateFile, noSecret, QA_PASS, runLocalJob } from "../helpers/qa-alias";

gateFile();

type Mode = "all" | "admins" | "off";
type Item = { text: string; href: string | null };
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
  // off closes the deal API, so there is nothing to seed. The product test covers that mode.
  if (mode === "off") {
    world = { mode, member, orgAdmin, dealId: "", dealName: "", memberTitle: "", memberTaskId: "", adminTitle: "", adminTaskId: "", opsTitle: "", opsTaskId: "" };
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
  const ops = await newProject(admin, later, { label: "ops", members: [{ who: member }, { who: orgAdmin }] });
  const opsTitle = zz("Ops check");
  const opsTaskId = await newTask(orgAdmin, ops.id, { title: opsTitle, assigneeId: member.user.id, dueDate: ymd(1) });
  await runLocalJob("reminders");
  world = { mode, member, orgAdmin, dealId: deal.id, dealName, memberTitle, memberTaskId, adminTitle, adminTaskId, opsTitle, opsTaskId };
});

test.afterAll(async () => {
  for (const fn of [...cleanup].reverse()) {
    try { await fn(); } catch { /* a ZZ-TEST row left behind is easier to find than a hidden cleanup error */ }
  }
});

test("qa:TC missing qa:TC missing qa:TC missing all and unset keep the deal reminder and the ops check", async () => {
  test.skip(!world || world.mode !== "all", `This server is CRM_VISIBLE=${world?.mode ?? "off"}. Unset reads as all.`);
  const w = useWorld();
  const memberItems = await bell(w.member);
  const adminItems = await bell(w.orgAdmin);
  noSecret(JSON.stringify({ memberItems, adminItems }));
  assertDealReminder(memberItems, w.memberTitle, w.memberTaskId);
  assertDealReminder(adminItems, w.adminTitle, w.adminTaskId);
  assertOps(memberItems, w);
});

test("qa:TC missing qa:TC missing qa:TC missing admins: a member gets no deal reminder and an admin still does", async () => {
  test.skip(!world || world.mode !== "admins", `This server is CRM_VISIBLE=${world?.mode ?? "off"}.`);
  const w = useWorld();
  const memberItems = await bell(w.member);
  const adminItems = await bell(w.orgAdmin);
  noSecret(JSON.stringify({ memberItems, adminItems }));
  assertNoDealReminder(memberItems, w);
  assertDealReminder(adminItems, w.adminTitle, w.adminTaskId);
  assertOps(memberItems, w);
});

test("qa:TC missing qa:TC missing off: nobody gets a deal reminder", async () => {
  // The deal routes answer 404 for every role when the CRM is off, so this spec cannot seed
  // "ZZ-TEST Acme renewal" there. The product test writes that mode against the test database.
  test.skip(world?.mode !== "off", `This server is CRM_VISIBLE=${world?.mode ?? "unknown"}. Off is covered by tests/jobs-reminders-crm.test.ts.`);
  test.skip(true, "CRM_VISIBLE=off closes the deal API, so the job cannot be seeded from this spec.");
});
