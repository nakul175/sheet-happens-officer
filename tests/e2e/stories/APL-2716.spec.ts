// APL-2716. Under CRM_VISIBLE=admins a non-admin's deal notices are one sentence
// with no href. Under all and unset (both crmMode "all") the bell matches main,
// including a non-member. workers=1. ZZ-TEST deals and nakul17+ aliases.
// Pam qa:TC: 3abdb652 (stage), 85782555 (next step), fcc1861b (stalled),
// a8042ed1 (all and unset), 4811612d (non-deal), d2ec503b (a leak fails the check).
// qa:TC-APL2716-d72b698a@v1 is the prod read-only smoke and is not run from here.
import { test, expect, zz } from "../support";
import { newProject, newTask, type Who } from "../g2";
import { createDeal, createOrg, dealBody, notices, projectOf } from "../helpers/claude-a";
import { pipelines } from "../helpers/deal-board";
import { bell } from "../helpers/jim-bell";
import { cast, gateFile, QA_PASS } from "../helpers/qa-alias";

gateFile();

const HIDDEN = "A deal you can't view was updated.";
const WIDTHS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;

type Item = { text: string; href: string | null };
type Role = "ADMIN" | "MEMBER";
type Mode = "all" | "admins";
type Person = { who: Who; role: Role };
type Deal = { id: string; name: string; step: string; stepId: string; stage: string };
type Plain = { title: string; id: string };
type Later = (fn: () => Promise<unknown>) => void;
type World = {
  mode: Mode;
  actor: string;
  orgAdmin: Person;
  member: Person;
  outsider: Person;
  adminDeal: Deal;
  memberDeal: Deal;
  kickoff: Plain;
  plain: Record<"orgAdmin" | "member" | "outsider", Plain>;
};

const cleanup: (() => Promise<unknown>)[] = [];
const later: Later = (fn) => { cleanup.push(fn); };
let world: World | null = null;

function useWorld() {
  if (!world) throw new Error("The story setup did not run.");
  return world;
}

/** all (and unset, which crmMode reads as all) shows every deal notice. admins hides them from a Member. */
function showsDeals(mode: Mode, role: Role) {
  return mode === "all" || role === "ADMIN";
}

async function bellItems(who: Who): Promise<Item[]> {
  const rows = await notices(who);
  return rows.map((item) => ({ text: item.text, href: item.href }));
}

async function crmModeOf(member: Who, admin: Who): Promise<Mode> {
  const [asMember, asAdmin] = await Promise.all([
    member.api.get("/api/deals/pipelines"),
    admin.api.get("/api/deals/pipelines"),
  ]);
  if (asAdmin.status === 404) throw new Error("CRM_VISIBLE=off has no deals to notify about. Start the server with all, unset, or admins.");
  if (asMember.status === 404 && asAdmin.status === 200) return "admins";
  if (asMember.status === 200 && asAdmin.status === 200) return "all";
  throw new Error(`Could not read CRM mode (member ${asMember.status}, admin ${asAdmin.status}).`);
}

async function moveStage(admin: Who, dealId: string) {
  const project = await projectOf(admin, dealId);
  const current = String(project.deal?.stage?.id ?? "");
  const stages = (project.deal?.pipeline?.stages ?? []) as { id: string; name: string; category: string; needsReason: boolean; requiredFields: string[] }[];
  const stage = stages.find((s) => s.id !== current && s.category !== "DONE" && s.category !== "LOST" && !s.needsReason && s.requiredFields.length === 0);
  expect(stage, "a working stage with no required reason or fields").toBeTruthy();
  const moved = await admin.api.post(`/api/projects/${dealId}/stage`, { stageId: stage!.id });
  expect(moved.status, JSON.stringify(moved.json)).toBe(200);
  return String(moved.json.stage.name);
}

async function finishStep(admin: Who, stepId: string) {
  const seen = await admin.api.get(`/api/tasks/${stepId}`);
  expect(seen.status, JSON.stringify(seen.json)).toBe(200);
  const done = await admin.api.post(`/api/tasks/${stepId}/complete`, { expectedUpdatedAt: seen.json.task.updatedAt });
  expect(done.status, JSON.stringify(done.json)).toBe(200);
}

async function openDeal(admin: Who, orgId: string, pipeId: string, leader: Who, label: string) {
  const name = zz(`Acme ${label} renewal`);
  const step = zz(`Acme ${label} step`);
  const deal = await createDeal(admin, later, dealBody({
    name, organisationId: orgId, pipelineId: pipeId, leaderId: String(leader.user.id), step,
  }));
  const project = await projectOf(admin, deal.id);
  const stepId = String(project.deal?.nextStep?.id ?? "");
  expect(stepId, `${label} next step`).toBeTruthy();
  const stage = await moveStage(admin, deal.id);
  await finishStep(admin, stepId);
  return { id: deal.id, name: deal.name, step, stepId, stage };
}

function stageText(actor: string, deal: Deal) {
  return `${actor} moved "${deal.name}" to ${deal.stage}.`;
}
function nextText(deal: Deal) {
  return `"${deal.name}" needs a next step.`;
}
function taskText(actor: string, title: string) {
  return `${actor} assigned you "${title}".`;
}
function removedText(actor: string, deal: Deal, kickoff: string) {
  return `${actor} removed you from "${deal.name}". Your open task "${kickoff}" was handed to someone else.`;
}

function assertNoLeak(body: string, w: World, label: string) {
  for (const name of [w.adminDeal.name, w.memberDeal.name, "Acme"]) expect(body, `${label} name`).not.toContain(name);
  for (const title of [w.adminDeal.step, w.memberDeal.step, w.kickoff.title]) expect(body, `${label} title`).not.toContain(title);
  for (const stage of [w.adminDeal.stage, w.memberDeal.stage]) expect(body, `${label} stage`).not.toContain(` to ${stage}.`);
  expect(body, `${label} next step`).not.toContain("needs a next step");
  expect(body, `${label} stalled`).not.toContain("has had no activity");
  for (const id of [w.adminDeal.id, w.memberDeal.id]) expect(body, `${label} deal href`).not.toContain(`/projects/${id}`);
  for (const id of [w.adminDeal.stepId, w.memberDeal.stepId, w.kickoff.id]) expect(body, `${label} task href`).not.toContain(`/tasks/${id}`);
}

async function openPanel(who: Who, size: { width: number; height: number }) {
  await who.page.setViewportSize(size);
  await who.page.goto("/");
  const button = bell(who.page);
  await expect(button).toBeVisible();
  await button.click();
  const panel = who.page.getByRole("dialog", { name: "Notifications" });
  await expect(panel).toBeVisible();
  return panel;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  if (!QA_PASS) return;
  const { admin, people } = await cast(browser, later, ["bell admin", "bell member", "bell out"]);
  const [orgAdmin, member, outsider] = people;
  const promoted = await admin.api.patch(`/api/team/${orgAdmin.user.id}`, { orgRole: "ADMIN" });
  expect(promoted.status, JSON.stringify(promoted.json)).toBe(200);
  const mode = await crmModeOf(member, admin);
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "Acme buyer");
  const actor = String(admin.user.name);
  const adminDeal = await openDeal(admin, org.id, pipes.pro.id, orgAdmin, "admin");
  const memberDeal = await openDeal(admin, org.id, pipes.pro.id, member, "member");
  const added = await admin.api.post(`/api/projects/${memberDeal.id}/members`, { userId: outsider.user.id, role: "EDITOR" });
  expect(added.status, JSON.stringify(added.json)).toBe(201);
  const kickoffTitle = zz("Acme kickoff");
  const kickoffId = await newTask(admin, memberDeal.id, { title: kickoffTitle, assigneeId: outsider.user.id });
  const removed = await admin.api.del(`/api/projects/${memberDeal.id}/members/${outsider.user.id}?handoverTo=${member.user.id}`);
  expect(removed.status, JSON.stringify(removed.json)).toBe(204);
  const packing = await newProject(admin, later, {
    label: "packing",
    members: [{ who: orgAdmin }, { who: member }, { who: outsider }],
  });
  const plainFor = async (who: Who, label: string): Promise<Plain> => {
    const title = zz(`Pack the cartons ${label}`);
    const id = await newTask(admin, packing.id, { title, assigneeId: who.user.id });
    return { title, id };
  };
  world = {
    mode, actor,
    orgAdmin: { who: orgAdmin, role: "ADMIN" },
    member: { who: member, role: "MEMBER" },
    outsider: { who: outsider, role: "MEMBER" },
    adminDeal, memberDeal,
    kickoff: { title: kickoffTitle, id: kickoffId },
    plain: {
      orgAdmin: await plainFor(orgAdmin, "admin"),
      member: await plainFor(member, "member"),
      outsider: await plainFor(outsider, "out"),
    },
  };
});

test.afterAll(async () => {
  for (const fn of [...cleanup].reverse()) {
    try { await fn(); } catch { /* a ZZ-TEST row left behind is easier to find than a hidden cleanup error */ }
  }
});

test("qa:TC-APL2716-3abdb652@v1 DEAL_STAGE_CHANGED is the generic sentence for a non-admin under admins, and the admin sentence stays", async () => {
  test.setTimeout(90_000);
  const w = useWorld();
  const adminItems = await bellItems(w.orgAdmin.who);
  const memberItems = await bellItems(w.member.who);
  expect(adminItems).toContainEqual({ text: stageText(w.actor, w.adminDeal), href: `/projects/${w.adminDeal.id}` });
  if (showsDeals(w.mode, "MEMBER")) {
    expect(memberItems).toContainEqual({ text: stageText(w.actor, w.memberDeal), href: `/projects/${w.memberDeal.id}` });
  } else {
    expect(memberItems).not.toContainEqual({ text: stageText(w.actor, w.memberDeal), href: `/projects/${w.memberDeal.id}` });
    expect(JSON.stringify(memberItems)).not.toContain(w.memberDeal.name);
    expect(memberItems).toContainEqual({ text: HIDDEN, href: null });
  }
  for (const size of WIDTHS) {
    const panel = await openPanel(w.member.who, size);
    // Opening the panel starts an async fetch; wait for its expected row before
    // taking the text snapshot used by the privacy assertions below.
    await expect(panel).toContainText(showsDeals(w.mode, "MEMBER") ? stageText(w.actor, w.memberDeal) : HIDDEN);
    const text = await panel.innerText();
    if (showsDeals(w.mode, "MEMBER")) {
      expect(text).toContain(stageText(w.actor, w.memberDeal));
      expect(await panel.locator(`a[href="/projects/${w.memberDeal.id}"]`).count()).toBeGreaterThan(0);
    } else {
      expect(text).toContain(HIDDEN);
      expect(text).not.toContain(w.memberDeal.name);
      expect(text).not.toContain("Acme");
      expect(text).not.toContain(` to ${w.memberDeal.stage}.`);
      expect(await panel.locator(`a[href="/projects/${w.memberDeal.id}"]`).count()).toBe(0);
      expect(await panel.locator(`a[href="/tasks/${w.plain.member.id}"]`).count()).toBeGreaterThan(0);
    }
  }
});

test("qa:TC-APL2716-85782555@v1 DEAL_NEEDS_NEXT_STEP is generic for a non-admin under admins, and the admin sentence stays", async () => {
  const w = useWorld();
  const adminItems = await bellItems(w.orgAdmin.who);
  const memberItems = await bellItems(w.member.who);
  expect(adminItems).toContainEqual({ text: nextText(w.adminDeal), href: `/projects/${w.adminDeal.id}` });
  if (showsDeals(w.mode, "MEMBER")) {
    expect(memberItems).toContainEqual({ text: nextText(w.memberDeal), href: `/projects/${w.memberDeal.id}` });
  } else {
    expect(JSON.stringify(memberItems)).not.toContain("needs a next step");
    expect(memberItems.filter((item) => item.text === HIDDEN && item.href === null).length).toBeGreaterThan(0);
  }
});

test("qa:TC-APL2716-fcc1861b@v1 DEAL_STALLED is generic for a non-admin under admins, and the admin sentence stays", async () => {
  // The stall notice is one per leader after 30 days of silence. A deal created in this run
  // is not stalled, and the stall job is not fired at a remote host. The sentence still has
  // to be absent, and a hidden bell must not carry the deal name that sentence would use.
  const w = useWorld();
  const phrase = "has had no activity";
  for (const person of [w.orgAdmin, w.member, w.outsider]) {
    const body = JSON.stringify(await bellItems(person.who));
    expect(body, person.role).not.toContain(phrase);
    if (!showsDeals(w.mode, person.role)) assertNoLeak(body, w, person.role);
  }
});

test("qa:TC-APL2716-a8042ed1@v1 all and unset leave the bell unchanged for an admin, an on-deal member and a non-member", async () => {
  const w = useWorld();
  const adminItems = await bellItems(w.orgAdmin.who);
  const memberItems = await bellItems(w.member.who);
  const outsiderItems = await bellItems(w.outsider.who);
  expect(adminItems).toContainEqual({ text: stageText(w.actor, w.adminDeal), href: `/projects/${w.adminDeal.id}` });
  expect(adminItems).toContainEqual({ text: nextText(w.adminDeal), href: `/projects/${w.adminDeal.id}` });
  expect(adminItems).toContainEqual({ text: taskText(w.actor, w.adminDeal.step), href: `/tasks/${w.adminDeal.stepId}` });
  if (w.mode === "all") {
    expect(memberItems).toContainEqual({ text: stageText(w.actor, w.memberDeal), href: `/projects/${w.memberDeal.id}` });
    expect(memberItems).toContainEqual({ text: nextText(w.memberDeal), href: `/projects/${w.memberDeal.id}` });
    expect(memberItems).toContainEqual({ text: taskText(w.actor, w.memberDeal.step), href: `/tasks/${w.memberDeal.stepId}` });
    expect(outsiderItems).toContainEqual({ text: taskText(w.actor, w.kickoff.title), href: `/tasks/${w.kickoff.id}` });
    expect(outsiderItems).toContainEqual({ text: removedText(w.actor, w.memberDeal, w.kickoff.title), href: `/projects/${w.memberDeal.id}` });
  } else {
    for (const items of [memberItems, outsiderItems]) {
      expect(JSON.stringify(items)).not.toContain(w.memberDeal.name);
      expect(items).toContainEqual({ text: HIDDEN, href: null });
    }
  }
});

test("qa:TC-APL2716-4811612d@v1 a non-deal task notice is unchanged in admins, all and unset", async () => {
  const w = useWorld();
  for (const key of ["orgAdmin", "member", "outsider"] as const) {
    const person = w[key];
    const note = w.plain[key];
    const items = await bellItems(person.who);
    expect(items, key).toContainEqual({ text: taskText(w.actor, note.title), href: `/tasks/${note.id}` });
  }
});

test("qa:TC-APL2716-d2ec503b@v1 the hidden bell fails when the deal name, task title, stage or deal href appears", async () => {
  const w = useWorld();
  for (const person of [w.member, w.outsider]) {
    if (showsDeals(w.mode, person.role)) continue;
    const body = JSON.stringify(await bellItems(person.who));
    assertNoLeak(body, w, "hidden");
    expect(body).toContain(HIDDEN);
    const planted = body.replaceAll(HIDDEN, stageText(w.actor, w.memberDeal));
    expect(planted).toContain(w.memberDeal.name);
    expect(() => assertNoLeak(planted, w, "planted")).toThrow();
  }
  const named = JSON.stringify(await bellItems(w.orgAdmin.who));
  expect(named).toContain(w.adminDeal.name);
  expect(() => assertNoLeak(named, w, "admin bell")).toThrow();
});
