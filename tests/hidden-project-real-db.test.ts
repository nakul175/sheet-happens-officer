// SHO-3027 (#156 S4). The APL-2995 rule against a real database: CRM_VISIBLE=off must keep a deal
// out of deactivate's `fellBack` and out of the person page, while the plain project stays named,
// and the hidden deal's work still moves to its own Leader. No mocks: the fixture is made through
// the API, deactivate runs its real Prisma transaction and releasePerson, and the rows are read back.
// Names are ZZ-TEST. Addresses are nakul17+ aliases.
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { projectAccess } from "@/lib/access";
import { deactivate, getPerson } from "@/lib/team";
import { listDeals } from "@/lib/deals";
import { account, superAdmin, task, type Account } from "./helpers";
import { cleanupHiddenProject, hiddenProjectFixture, withCrmMode, type HiddenProjectFixture } from "./hidden-project";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const HIDDEN_DEAL_LABEL = "A deal you can't view.";
let seq = 0;

const people: Account[] = [];
const fixtures: HiddenProjectFixture[] = [];

const actor = (who: Account, orgRole: "MEMBER" | "ADMIN" = "MEMBER") => ({ id: who.id, orgRole });

async function zzAccount(label: string) {
  const n = seq++;
  const email = `nakul17+zz-3027-${RUN}-${label.replace(/[^a-z0-9]+/gi, "")}-${n}@aplyd.com`;
  const who = await account(`ZZ-TEST ${label} ${RUN}-${n}`, email);
  people.push(who);
  return who;
}

/** Asserts the call answers with the ApiError status the hidden path should give, and returns its message. */
async function refused(fn: () => Promise<unknown>, status: number): Promise<string> {
  let answer: unknown;
  try {
    answer = await fn();
  } catch (err) {
    expect(err, "the hidden path must throw an ApiError").toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
    return (err as ApiError).message;
  }
  throw new Error(`expected ${status}, got a value: ${JSON.stringify(answer)}`);
}

describe("qa:TC missing SHO-3027 real-DB hidden project isolation (APL-2995 fellBack)", () => {
  let adminUser: Account;
  let target: Account;
  let targetVisible: Account;
  /** SHO-3029: one leaver measured twice on the same rows, once with the deal visible and once hidden. */
  let deltaTarget: Account;
  const deltaTaskIds: string[] = [];
  let dealLeader: Account;
  let plainLeader: Account;
  let viewer: Account;
  let named: Account;
  let off: HiddenProjectFixture;
  let visible: HiddenProjectFixture;
  let dealTaskId = "";
  let plainTaskId = "";

  afterAll(async () => {
    await cleanupHiddenProject(fixtures, people);
  });

  it("qa:TC missing seeds two real fixtures: a hidden deal plus a plain control, led by two people", async () => {
    const sa = await superAdmin();
    adminUser = await zzAccount("admin");
    target = await zzAccount("target");
    targetVisible = await zzAccount("target visible");
    deltaTarget = await zzAccount("delta target");
    dealLeader = await zzAccount("deal leader");
    plainLeader = await zzAccount("plain leader");
    viewer = await zzAccount("viewer");
    named = await zzAccount("named fallback");
    expect((await sa.c.patch(`/api/team/${adminUser.id}`, { orgRole: "ADMIN" })).status).toBe(200);

    off = await hiddenProjectFixture(sa, {
      leader: dealLeader,
      plainLeader,
      label: `${RUN} hidden`,
      members: [target, viewer, deltaTarget],
    });
    fixtures.push(off);

    // The same shape again, for the CRM_VISIBLE=all direction: deactivating is one-shot, so the
    // visible-mode answer needs its own leaver.
    visible = await hiddenProjectFixture(sa, {
      leader: dealLeader,
      plainLeader,
      label: `${RUN} visible`,
      members: [targetVisible, viewer],
      organisationId: off.organisationId,
      pipelineId: off.pipelineId,
    });
    fixtures.push(visible);

    // Each leaver holds one open task in the deal and one in the plain project: the hidden project
    // must still be processed, only not named.
    dealTaskId = await task(sa, off.deal.id, { dueDate: "2031-03-20", title: `ZZ-TEST ${RUN} deal work`, assigneeId: target.id });
    plainTaskId = await task(sa, off.plain.id, { dueDate: "2031-03-20", title: `ZZ-TEST ${RUN} plain work`, assigneeId: target.id });
    // Three in the deal and two in the plain project, so a leaked count is unmistakable: 5 vs 2.
    for (const i of [0, 1, 2]) await task(sa, visible.deal.id, { dueDate: "2031-03-20", title: `ZZ-TEST ${RUN} visible deal work ${i}`, assigneeId: targetVisible.id });
    for (const i of [0, 1]) await task(sa, visible.plain.id, { dueDate: "2031-03-20", title: `ZZ-TEST ${RUN} visible plain work ${i}`, assigneeId: targetVisible.id });
    // SHO-3029: the same 3 + 2 shape again, on the fixture that is hidden under CRM_VISIBLE=off. One
    // leaver, measured twice on these very rows, so the count delta is the proof and not an absolute number.
    for (const i of [0, 1, 2]) deltaTaskIds.push(await task(sa, off.deal.id, { dueDate: "2031-03-20", title: `ZZ-TEST ${RUN} delta deal work ${i}`, assigneeId: deltaTarget.id }));
    for (const i of [0, 1]) deltaTaskIds.push(await task(sa, off.plain.id, { dueDate: "2031-03-20", title: `ZZ-TEST ${RUN} delta plain work ${i}`, assigneeId: deltaTarget.id }));
  });

  it("qa:TC missing AC: under off the real projector and person page hide the deal but keep the plain project", async () => {
    // A real project row read: the deal must answer like a missing id, the plain project must load.
    const hiddenMessage = await withCrmMode("off", () => refused(() => projectAccess(actor(viewer), off.deal.id), 404));
    expect(hiddenMessage).toBe("Project not found");
    const plain = await withCrmMode("off", () => projectAccess(actor(viewer), off.plain.id));
    expect(plain.project.id).toBe(off.plain.id);

    // CRM_VISIBLE=off hides the CRM from everyone, the admin included; the row itself still exists.
    await withCrmMode("off", () => refused(() => projectAccess(actor(adminUser, "ADMIN"), off.deal.id), 404));
    const row = await db.project.findUnique({ where: { id: off.deal.id }, select: { id: true, typeId: true } });
    expect(row).toEqual({ id: off.deal.id, typeId: "wst_deal" });

    const person = await withCrmMode("off", () => getPerson(actor(viewer), viewer.id));
    const text = JSON.stringify(person);
    expect(text).not.toContain(off.deal.name);
    expect(text).not.toContain(off.deal.id);
    expect(person.projects.filter((p) => "href" in p && p.href === null)).toEqual([{ name: HIDDEN_DEAL_LABEL, href: null }]);
    expect(person.projects).toContainEqual({ id: off.plain.id, name: off.plain.name });

    // The same rows, same database, once the caller can see the CRM.
    const seen = await withCrmMode("all", () => getPerson(actor(viewer), viewer.id));
    expect(JSON.stringify(seen)).toContain(off.deal.name);
    expect(JSON.stringify(seen)).toContain(off.deal.id);
  });

  it("qa:TC missing AC1: under off deactivate's fellBack names the plain project only, and the deal keeps its name out of the answer", async () => {
    const res = await withCrmMode("off", () => deactivate(actor(adminUser, "ADMIN"), target.id, named.id));
    expect(res.fellBack).toEqual([off.plain.name]);
    // SHO-3029: the count carries only what the caller can see. The deal's task moved (asserted below),
    // but counting it would tell this admin that a deal with work in it exists.
    expect(res.moved).toBe(1);
    const text = JSON.stringify(res);
    expect(text).not.toContain(off.deal.name);
    expect(text).not.toContain(off.deal.id);

    // The hidden deal was not skipped: its task moved to that deal's Leader, in the real transaction.
    const dealTask = await db.task.findUnique({ where: { id: dealTaskId }, select: { assigneeId: true } });
    const plainTask = await db.task.findUnique({ where: { id: plainTaskId }, select: { assigneeId: true } });
    expect(dealTask?.assigneeId).toBe(dealLeader.id);
    expect(plainTask?.assigneeId).toBe(plainLeader.id);
    const offLeaver = await db.user.findUnique({ where: { id: target.id }, select: { deactivatedAt: true } });
    expect(offLeaver?.deactivatedAt).not.toBeNull();
  });

  it("qa:TC missing AC2: under all the same fixture names both projects, so the guard is the lever and not the fixture", async () => {
    const res = await withCrmMode("all", () => deactivate(actor(adminUser, "ADMIN"), targetVisible.id, named.id));
    expect(res.fellBack).toHaveLength(2);
    expect(res.fellBack).toEqual(expect.arrayContaining([visible.deal.name, visible.plain.name]));
    // SHO-3029: with the CRM visible, the same 3 + 2 shape is counted in full.
    expect(res.moved).toBe(5);
  });

  // SHO-3029 step 1. The refusal /api/deals gives a CRM-hidden actor: requireCrm() throws notFound("Page"),
  // which is what listDeals — the only work GET /api/deals does — does. Proven here at the function the
  // route calls, and against a live server in W44-REPORT.md.
  it("qa:TC missing SHO-3029: the hidden actor is refused /api/deals' work, the same actor is not under all", async () => {
    await withCrmMode("off", async () => {
      const message = await refused(() => listDeals(actor(adminUser, "ADMIN"), {}), 404);
      expect(message).toBe("Page not found");
    });
    const seen = await withCrmMode("all", () => listDeals(actor(adminUser, "ADMIN"), {}));
    expect(seen.map((d) => d.id)).toContain(off.deal.id);
  });

  // SHO-3029 AC. The same leaver, the same rows, the only difference the lever: 5 moved with the deal
  // visible, 2 with it hidden, so the 3-task delta is the hidden deal rather than an absolute number
  // that a wrong fixture could also produce. `reassign: "leaders"` is the branch 2f92bfc left
  // uncovered: it names no person, so `fellBack` stays empty and `moved` is the only leak vector.
  it("qa:TC missing SHO-3029 AC: the same rows count 5 with the deal visible and 2 hidden, a delta of the deal's 3", async () => {
    const visibleArm = await withCrmMode("all", () => deactivate(actor(adminUser, "ADMIN"), deltaTarget.id, "leaders"));
    expect(visibleArm.fellBack).toEqual([]);
    expect(visibleArm.moved).toBe(5);
    const handedToLeader = await db.task.findMany({ where: { id: { in: deltaTaskIds } }, select: { assigneeId: true } });
    expect(handedToLeader.every((t) => t.assigneeId === dealLeader.id || t.assigneeId === plainLeader.id)).toBe(true);

    // Put the very same rows back, so only the lever differs between the two measurements.
    await db.user.update({ where: { id: deltaTarget.id }, data: { deactivatedAt: null } });
    await db.task.updateMany({ where: { id: { in: deltaTaskIds } }, data: { assigneeId: deltaTarget.id } });

    const hiddenArm = await withCrmMode("off", () => deactivate(actor(adminUser, "ADMIN"), deltaTarget.id, "leaders"));
    expect(hiddenArm.fellBack).toEqual([]);
    expect(hiddenArm.moved).toBe(2);
    expect(visibleArm.moved - hiddenArm.moved).toBe(3);

    // Redacted, not skipped: the hidden deal's work still went to that deal's Leader.
    const dealIds = deltaTaskIds.slice(0, 3);
    const plainIds = deltaTaskIds.slice(3);
    const dealTasks = await db.task.findMany({ where: { id: { in: dealIds } }, select: { assigneeId: true } });
    const plainTasks = await db.task.findMany({ where: { id: { in: plainIds } }, select: { assigneeId: true } });
    expect(dealTasks.map((t) => t.assigneeId)).toEqual([dealLeader.id, dealLeader.id, dealLeader.id]);
    expect(plainTasks.map((t) => t.assigneeId)).toEqual([plainLeader.id, plainLeader.id]);
  });
});
