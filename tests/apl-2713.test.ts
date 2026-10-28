// APL-2713. A task handed to an approver (previousAssigneeId → Waiting on others) must use the same
// CRM project filter as open work. These call myTasks in this process and flip CRM_VISIBLE here.
// The live server per mode is tests/apl-2713-crm-modes.test.ts (npm run test:crm-modes).
// Seeding goes through the app, which must be running with the CRM visible (the default).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actor } from "./concierge-helpers";
import { account, admin, istDate, project, superAdmin, task, type Account } from "./helpers";
import type { Actor } from "../src/lib/access";
import { db } from "../src/lib/db";
import { myTasks } from "../src/lib/tasks";

const DEAL_NAME = "ZZ-TEST Acme renewal";
const KICKOFF = "ZZ-TEST Acme kickoff";
const CONTRACT = "ZZ-TEST Acme contract";
const PLAIN = "ZZ-TEST plain handoff";
const STAGE = "Proposal";

type Groups = Awaited<ReturnType<typeof myTasks>>;
type Row = {
  id: string;
  title: string;
  assignee?: { id: string };
  project: { id: string; name: string; type: string; stage: string | null };
};

const KEYS = ["waitingOnMe", "waitingOnOthers", "overdue", "next7", "later"] as const;

const rows = (groups: Groups, key: (typeof KEYS)[number]) => groups[key] as Row[];
const findRow = (groups: Groups, id: string) => rows(groups, "waitingOnOthers").find((t) => t.id === id);

function assertDealHidden(groups: Groups, label: string) {
  for (const key of KEYS) {
    const blob = JSON.stringify(groups[key]);
    expect(blob, `${label} ${key} names the deal`).not.toContain(DEAL_NAME);
    expect(blob, `${label} ${key} names the stage`).not.toContain(STAGE);
    expect(blob, `${label} ${key} names the kickoff`).not.toContain(KICKOFF);
    expect(blob, `${label} ${key} has type DEAL`).not.toContain('"type":"DEAL"');
    expect(rows(groups, key).some((t) => t.project.type === "DEAL" || t.id === seed.kickoffId || t.id === seed.contractId), `${label} ${key}`).toBe(false);
  }
  expect(rows(groups, "waitingOnOthers").some((t) => t.project.id === seed.dealId), `${label} waitingOnOthers`).toBe(false);
}

async function withMode(mode: string, fn: () => Promise<void>) {
  const prev = process.env.CRM_VISIBLE;
  process.env.CRM_VISIBLE = mode;
  try { await fn(); } finally { if (prev === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = prev; }
}

const seed: {
  editor?: Account;
  adminUser?: Account;
  approver?: Account;
  dealId: string;
  plainProjectId: string;
  kickoffId: string;
  contractId: string;
  plainId: string;
  userIds: string[];
} = { dealId: "", plainProjectId: "", kickoffId: "", contractId: "", plainId: "", userIds: [] };

describe("qa:TC missing APL-2713 handed-off deal tasks follow CRM visibility", () => {
  beforeAll(async () => {
    const sa = await superAdmin();
    const adminUser = await admin(sa, "apl2713admin");
    const editor = await account("editor");
    const approver = await account("approver");
    seed.editor = editor;
    seed.adminUser = adminUser;
    seed.approver = approver;
    seed.userIds.push(adminUser.id, editor.id, approver.id);

    const pipes = await approver.c.get("/api/deals/pipelines");
    expect(pipes.status, JSON.stringify(pipes.json)).toBe(200);
    const proactive = pipes.json.pipelines.find((p: { key: string }) => p.key === "DEAL_PROACTIVE");
    const proposal = proactive.stages.find((s: { name: string }) => s.name === STAGE);
    expect(proposal?.id).toBeTruthy();
    const org = await approver.c.post("/api/orgs", { force: true, name: `ZZ-TEST Buyer ${Date.now()}` });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    const made = await editor.c.post("/api/deals", {
      name: DEAL_NAME,
      organisationId: org.json.organisation.id,
      pipelineId: proactive.id,
      leaderId: approver.id,
      whyPursue: "Renew the agreement",
      nextStep: { title: "Call the buyer", dueDate: istDate(3) },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    seed.dealId = made.json.deal.id as string;
    expect((await approver.c.post(`/api/projects/${seed.dealId}/members`, { userId: adminUser.id, role: "EDITOR" })).status).toBe(201);
    expect((await editor.c.post(`/api/projects/${seed.dealId}/stage`, { stageId: proposal.id })).status).toBe(200);

    seed.kickoffId = await task(approver, seed.dealId, { title: KICKOFF, assigneeId: editor.id, approverId: approver.id, dueDate: istDate(4) });
    expect((await editor.c.post(`/api/tasks/${seed.kickoffId}/send-for-approval`)).status).toBe(200);
    seed.contractId = await task(approver, seed.dealId, { title: CONTRACT, assigneeId: adminUser.id, approverId: approver.id, dueDate: istDate(5) });
    expect((await adminUser.c.post(`/api/tasks/${seed.contractId}/send-for-approval`)).status).toBe(200);

    const plainProject = await project(approver, approver, [{ who: editor }]);
    seed.plainProjectId = plainProject.id;
    seed.plainId = await task(approver, plainProject.id, { title: PLAIN, assigneeId: editor.id, approverId: approver.id, dueDate: istDate(4) });
    expect((await editor.c.post(`/api/tasks/${seed.plainId}/send-for-approval`)).status).toBe(200);
    await task(approver, plainProject.id, { title: "ZZ-TEST overdue", assigneeId: editor.id, dueDate: istDate(-2) });
    await task(approver, plainProject.id, { title: "ZZ-TEST next week", assigneeId: editor.id, dueDate: istDate(2) });
    await task(approver, plainProject.id, { title: "ZZ-TEST later", assigneeId: editor.id, dueDate: istDate(20) });
    const waiting = await task(approver, plainProject.id, { title: "ZZ-TEST waiting on editor", assigneeId: approver.id, approverId: editor.id, dueDate: istDate(6) });
    expect((await approver.c.post(`/api/tasks/${waiting}/send-for-approval`)).status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    const ids = seed.userIds;
    const projectIds = [seed.dealId, seed.plainProjectId].filter(Boolean);
    if (ids.length) {
      await db.actionLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { projectId: { in: projectIds } }] } });
      await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
      await db.modelUsage.deleteMany({ where: { userId: { in: ids } } });
    }
    if (projectIds.length) await db.project.deleteMany({ where: { id: { in: projectIds } } });
    if (ids.length) {
      await db.loginAttempt.deleteMany({ where: { email: { in: [seed.editor?.email, seed.adminUser?.email, seed.approver?.email].filter((e): e is string => !!e) } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
    }
  });

  // qa:TC missing · off for editor, off for admin, and admins for a non-admin hide the deal.
  it("qa:TC missing hides handed-off deal tasks when the CRM is hidden", async () => {
    const editor = actor(seed.editor!);
    const adm = actor(seed.adminUser!, "ADMIN");
    const cases: { mode: string; who: Actor; label: string }[] = [
      { mode: "off", who: editor, label: "off editor" },
      { mode: "off", who: adm, label: "off admin" },
      { mode: "admins", who: editor, label: "admins editor" },
    ];
    for (const c of cases) {
      await withMode(c.mode, async () => {
        const groups = await myTasks(c.who);
        assertDealHidden(groups, c.label);
        if (c.who === editor) expect(findRow(groups, seed.plainId), c.label).toBeTruthy();
      });
    }
  });

  // qa:TC missing · all for editor, and admins for an admin, match the visible (main) result.
  it("qa:TC missing shows the handed-off deal task when the CRM is visible", async () => {
    const editor = actor(seed.editor!);
    const adm = actor(seed.adminUser!, "ADMIN");
    let kickoffAll: Row | undefined;
    let contractAll: Row | undefined;
    await withMode("all", async () => {
      kickoffAll = findRow(await myTasks(editor), seed.kickoffId);
      contractAll = findRow(await myTasks(adm), seed.contractId);
    });
    expect(kickoffAll?.title).toBe(KICKOFF);
    expect(kickoffAll?.project).toEqual({ id: seed.dealId, name: DEAL_NAME, type: "DEAL", stage: STAGE });
    expect(kickoffAll?.assignee?.id).toBe(seed.approver!.id);
    expect(contractAll?.title).toBe(CONTRACT);
    expect(contractAll?.project).toEqual({ id: seed.dealId, name: DEAL_NAME, type: "DEAL", stage: STAGE });

    await withMode("admins", async () => {
      const contract = findRow(await myTasks(adm), seed.contractId);
      expect(contract).toEqual(contractAll);
    });
  });

  // qa:TC missing · the project handoff stays, and the other four groups match mode all.
  it("qa:TC missing keeps a handed-off project task and the other groups match main", async () => {
    const editor = actor(seed.editor!);
    const baseline = await withModeValue("all", () => myTasks(editor));
    expect(findRow(baseline, seed.plainId)?.title).toBe(PLAIN);
    expect(findRow(baseline, seed.plainId)?.project.type).toBe("PROJECT");
    for (const mode of ["all", "off", "admins"]) {
      await withMode(mode, async () => {
        const groups = await myTasks(editor);
        expect(findRow(groups, seed.plainId), mode).toEqual(findRow(baseline, seed.plainId));
        expect(groups.waitingOnMe, mode).toEqual(baseline.waitingOnMe);
        expect(groups.overdue, mode).toEqual(baseline.overdue);
        expect(groups.next7, mode).toEqual(baseline.next7);
        expect(groups.later, mode).toEqual(baseline.later);
      });
    }
  });
});

async function withModeValue<T>(mode: string, fn: () => Promise<T>) {
  const prev = process.env.CRM_VISIBLE;
  process.env.CRM_VISIBLE = mode;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = prev; }
}
