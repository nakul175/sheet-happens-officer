// APL-2609 (SHO-BUG-2) and APL-2726 (CRM_VISIBLE enforcement): one test per acceptance criterion.
// With CRM_VISIBLE=off no deal, deal task or stage reaches My tasks, search, the task routes, for anyone;
// with `admins` the same for everyone but Admins and the Super Admin; with `all` nothing changes.
// The server runs with the default `all`, so these call src/lib directly (same database) and flip process.env.CRM_VISIBLE
// in this process; `crmMode()` reads it at call time. tests/e2e/local/APL-2609.mode.test.ts drives a real server per mode.
// Pam left no qa:TC id on the issue, so every title says "qa:TC missing".
// Everything this file makes is named ZZ-TEST and cleaned up in afterAll, never by writing to the database: through the API
// (leadership handed to the ZZ-TEST Super Admin, projects and the organisation archived, chats cleared, sessions signed out),
// and the per-run people deactivated with src/lib/team's deactivate(), the function the deactivate route calls, because this
// file has no real Admin session. The shared root Super Admin is never used: the Admin and the Super Admin are ZZ-TEST people
// acting with that org role on the Actor. The Super Admin is one fixed ZZ-TEST account reused by every run, so it is the
// only ZZ-TEST account left active.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { account, istDate, task, type Account } from "./helpers";
import { actor } from "./actor";
import type { Actor } from "../src/lib/access";
import { crmMode } from "../src/lib/crm";
import { getTask, listTasks, myTasks } from "../src/lib/tasks";
import { search } from "../src/lib/search";
import { deactivate } from "../src/lib/team";

const STAGE = "Proposal";
const GROUPS = ["waitingOnMe", "overdue", "next7", "later", "waitingOnOthers"] as const;
type Row = { id: string; project: { id: string; type: string; stage: string | null } };

type World = {
  tag: string; dealId: string; dealName: string; dealTask: string; dealTaskTitle: string; plainTask: string; plainTaskTitle: string;
  ed: Actor; adm: Actor; sa: Actor;
};
let w: World;
const made: { people: Account[]; lead?: Account; sa?: Account; plainId?: string; projectIds: string[]; orgId?: string } = { people: [], projectIds: [] };

/**
 * The lead hands both projects to the Super Admin (a Leader cannot be deactivated), the Super Admin archives them, the lead
 * archives the organisation, everyone clears their chat and signs out, and the Super Admin deactivates the per-run people.
 * Every step must succeed, or the run fails with the list.
 */
async function cleanup() {
  const failed: string[] = [];
  const must = async (what: string, r: Promise<{ status: number }>) => {
    const res = await r.catch(() => ({ status: 0 }));
    if (res.status < 200 || res.status > 299) failed.push(`${what}: ${res.status}`);
  };
  const { lead, sa } = made;
  if (lead && sa) {
    if (made.plainId) await must("add the Super Admin to the plain project", lead.c.post(`/api/projects/${made.plainId}/members`, { userId: sa.id, role: "EDITOR" }));
    for (const id of made.projectIds) {
      await must(`hand project ${id} to the Super Admin`, lead.c.post(`/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" }));
      await must(`archive project ${id}`, sa.c.post(`/api/projects/${id}/archive`));
    }
    if (made.orgId) await must(`archive organisation ${made.orgId}`, lead.c.post(`/api/orgs/${made.orgId}/archive`, { archive: true }));
  }
  for (const who of made.people) {
    await must(`sign out ${who.email}`, who.c.post("/api/auth/signout"));
  }
  if (sa) {
    for (const who of made.people.filter((p) => p.id !== sa.id)) {
      try { await deactivate(actor(sa, "SUPER_ADMIN"), who.id, "leaders"); } catch (e) { failed.push(`deactivate ${who.email}: ${(e as Error).message}`); }
    }
  }
  if (failed.length) throw new Error(`ZZ-TEST cleanup failed: ${failed.join("; ")}`);
}

function setMode(mode: string) { process.env.CRM_VISIBLE = mode; }
const prevMode = process.env.CRM_VISIBLE;
afterEach(() => { if (prevMode === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = prevMode; });

/** Every My tasks group, as one list. */
const rows = async (u: Actor) => {
  const g = (await myTasks(u)) as unknown as Record<(typeof GROUPS)[number], Row[]>;
  return GROUPS.flatMap((k) => g[k]);
};

/** Everything one person can learn about the deal on the four surfaces, as booleans and statuses. */
async function surfaces(u: Actor) {
  const mine = await rows(u);
  const byTask = await search(u, w.dealTaskTitle, false);
  const byName = await search(u, w.dealName, false);
  const status = async (fn: () => Promise<unknown>) => { try { await fn(); return 200; } catch (e) { return (e as { status?: number }).status ?? 500; } };
  return {
    myTasks: mine.some((t) => t.id === w.dealTask),
    stage: mine.some((t) => t.project.type === "DEAL" || t.project.stage === STAGE),
    searchTask: byTask.tasks.some((t) => t.id === w.dealTask),
    searchDeal: byName.projects.some((p) => p.id === w.dealId),
    taskRoute: await status(() => getTask(u, w.dealTask)),
    listRoute: await status(() => listTasks(u, w.dealId, {})),
  };
}

const HIDDEN = {
  myTasks: false, stage: false, searchTask: false, searchDeal: false, taskRoute: 404, listRoute: 404,
};
const SHOWN = {
  myTasks: true, stage: true, searchTask: true, searchDeal: true, taskRoute: 200, listRoute: 200,
};

describe("qa:TC missing APL-2609 CRM_VISIBLE hides deals from My tasks, search, the task routes", () => {

  beforeAll(async () => {
    const run = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    const zzPerson = (role: string) => account(`ZZ-TEST cv2609 ${role}`, `zz-test-cv2609-${role}-${run}@aplyd.com`);
    const saAcc = await account("ZZ-TEST cv2609 superadmin", "zz-test-cv2609-superadmin@aplyd.com");
    made.sa = saAcc;
    const adAcc = await zzPerson("admin");
    const lead: Account = await zzPerson("lead");
    const edAcc: Account = await zzPerson("editor");
    made.lead = lead;
    made.people.push(saAcc, adAcc, lead, edAcc);
    const tag = `cv2609x${Date.now()}`;
    const pipes = (await lead.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string; stages: { id: string; name: string }[] }[];
    const pipe = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
    const orgId = (await lead.c.post("/api/orgs", { name: `ZZ-TEST Org ${tag}` })).json.organisation.id as string;
    made.orgId = orgId;
    const dealName = `ZZ-TEST Deal ${tag}`;
    const deal = await lead.c.post("/api/deals", { name: dealName, organisationId: orgId, pipelineId: pipe.id, leaderId: lead.id, whyPursue: "fit", nextStep: { title: `ZZ-TEST First ${tag}`, dueDate: istDate(3) } });
    expect(deal.status, JSON.stringify(deal.json)).toBe(201);
    const dealId = deal.json.deal.id as string;
    made.projectIds.push(dealId);
    const proposal = pipe.stages.find((s) => s.name === STAGE)!;
    expect((await lead.c.post(`/api/projects/${dealId}/stage`, { stageId: proposal.id })).status).toBe(200);
    // The Editor, the Admin and the Super Admin are all members of the deal; each holds the deal task due this week.
    for (const who of [edAcc, adAcc, saAcc]) expect((await lead.c.post(`/api/projects/${dealId}/members`, { userId: who.id, role: "EDITOR" })).status).toBe(201);
    const dealTaskTitle = `ZZ-TEST Deal step ${tag}`;
    const dealTask = await task(lead, dealId, { title: dealTaskTitle, assigneeId: edAcc.id, dueDate: istDate(2) });
    for (const who of [adAcc, saAcc]) expect((await lead.c.post(`/api/tasks/${dealTask}/collaborators`, { userId: who.id })).status).toBe(201);
    const plain = await lead.c.post("/api/projects", { name: `ZZ-TEST Plain ${tag}`, leaderId: lead.id });
    expect(plain.status, JSON.stringify(plain.json)).toBe(201);
    const p = { id: plain.json.project.id as string };
    made.plainId = p.id;
    made.projectIds.push(p.id);
    expect((await lead.c.post(`/api/projects/${p.id}/members`, { userId: edAcc.id, role: "EDITOR" })).status).toBe(201);
    const plainTaskTitle = `ZZ-TEST Plain step ${tag}`;
    const plainTask = await task(lead, p.id, { title: plainTaskTitle, assigneeId: edAcc.id, dueDate: istDate(2) });
    w = {
      tag, dealId, dealName, dealTask, dealTaskTitle, plainTask, plainTaskTitle,
      ed: actor(edAcc), adm: actor(adAcc, "ADMIN"), sa: actor(saAcc, "SUPER_ADMIN"),
    };
  });

  afterAll(cleanup);

  it("qa:TC missing AC1: with CRM_VISIBLE=off, My tasks shows a deal member no deal task and no stage", async () => {
    setMode("off");
    const mine = await rows(w.ed);
    expect(mine.some((t) => t.id === w.dealTask)).toBe(false);
    expect(mine.some((t) => t.project.id === w.dealId || t.project.type === "DEAL" || t.project.stage)).toBe(false);
    expect(JSON.stringify(mine)).not.toContain(w.dealName);
    expect(mine.some((t) => t.id === w.plainTask)).toBe(true);
  });

  it("qa:TC missing AC2: with CRM_VISIBLE=off, searching the deal name or a deal task title returns nothing of the deal", async () => {
    setMode("off");
    for (const q of [w.dealName, w.dealTaskTitle, w.tag]) {
      const r = await search(w.ed, q, false);
      expect(r.projects.some((p) => p.id === w.dealId || p.type === "DEAL"), q).toBe(false);
      expect(r.tasks.some((t) => t.id === w.dealTask || t.project.id === w.dealId), q).toBe(false);
      expect(JSON.stringify(r), q).not.toContain(w.dealName);
    }
    expect((await search(w.ed, w.plainTaskTitle, false)).tasks.some((t) => t.id === w.plainTask)).toBe(true);
  });

  it("qa:TC missing AC3: with CRM_VISIBLE=off, the deal task detail and the deal task list answer not found", async () => {
    setMode("off");
    await expect(getTask(w.ed, w.dealTask)).rejects.toMatchObject({ status: 404 });
    await expect(listTasks(w.ed, w.dealId, {})).rejects.toMatchObject({ status: 404 });
    expect((await getTask(w.ed, w.plainTask)).id).toBe(w.plainTask);
  });

  it("qa:TC missing AC5: with CRM_VISIBLE=admins, an Editor sees no deal data on any surface", async () => {
    setMode("admins");
    expect(await surfaces(w.ed)).toEqual(HIDDEN);
  });

  it("qa:TC missing AC6: with CRM_VISIBLE=admins, an Admin and the Super Admin see deal tasks as normal", async () => {
    setMode("admins");
    expect(await surfaces(w.adm)).toEqual(SHOWN);
    // The Super Admin holds the deal task too: it is in their own My tasks, concierge lists and quick actions, with its stage.
    expect(await surfaces(w.sa)).toEqual(SHOWN);
    expect((await rows(w.sa)).find((t) => t.id === w.dealTask)?.project).toMatchObject({ id: w.dealId, type: "DEAL", stage: STAGE });
  });

  it("qa:TC missing AC7: with CRM_VISIBLE=all, every member's behaviour is unchanged", async () => {
    setMode("all");
    expect(crmMode()).toBe("all");
    expect(await surfaces(w.ed)).toEqual(SHOWN);
    expect(await surfaces(w.adm)).toEqual(SHOWN);
    const mine = await rows(w.ed);
    expect(mine.find((t) => t.id === w.dealTask)?.project).toMatchObject({ id: w.dealId, type: "DEAL", stage: STAGE });
  });

  it("qa:TC missing AC8: CRM_VISIBLE=off hides deals from Admins and the Super Admin too; admins mode keeps them in", async () => {
    setMode("off");
    expect(await surfaces(w.adm)).toEqual(HIDDEN);
    expect(await surfaces(w.sa)).toEqual(HIDDEN);
    setMode("admins");
    expect((await surfaces(w.adm)).taskRoute).toBe(200);
    expect((await surfaces(w.sa)).taskRoute).toBe(200);
  });
});
