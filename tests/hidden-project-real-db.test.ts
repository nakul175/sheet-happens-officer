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
    dealLeader = await zzAccount("deal leader");
    plainLeader = await zzAccount("plain leader");
    viewer = await zzAccount("viewer");
    named = await zzAccount("named fallback");
    expect((await sa.c.patch(`/api/team/${adminUser.id}`, { orgRole: "ADMIN" })).status).toBe(200);

    off = await hiddenProjectFixture(sa, {
      leader: dealLeader,
      plainLeader,
      label: `${RUN} hidden`,
      members: [target, viewer],
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
    dealTaskId = await task(sa, off.deal.id, { title: `ZZ-TEST ${RUN} deal work`, assigneeId: target.id });
    plainTaskId = await task(sa, off.plain.id, { title: `ZZ-TEST ${RUN} plain work`, assigneeId: target.id });
    await task(sa, visible.deal.id, { title: `ZZ-TEST ${RUN} visible deal work`, assigneeId: targetVisible.id });
    await task(sa, visible.plain.id, { title: `ZZ-TEST ${RUN} visible plain work`, assigneeId: targetVisible.id });
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
  });
});
