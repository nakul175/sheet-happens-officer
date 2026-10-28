// APL-2995. deactivate's `fellBack` must not name a deal the caller cannot see.
// SHO-3029. Its `moved` count must not count tasks on a deal the caller cannot see either, because
// that count alone reveals the hidden deal exists. The tasks still move to the deal's Leader.
// No server and no database: @/lib/db, the membership helpers, releasePerson and auditTx are faked here,
// so nothing is written anywhere. crmVisible is the real one and reads CRM_VISIBLE at call time.
// Names are ZZ-TEST.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DEAL = { projectId: "zz-deal-2995", role: "EDITOR", project: { name: "ZZ-TEST Northwind deal 2995", typeId: "wst_deal" } };
const PLAIN = { projectId: "zz-plain-2995", role: "EDITOR", project: { name: "ZZ-TEST Plain project 2995", typeId: "wst_project" } };
const TARGET = { id: "zz-target-2995", orgRole: "MEMBER", email: "nakul17+zz-2995-target@aplyd.com", deactivatedAt: null, emailVerifiedAt: new Date() };
const NAMED = { id: "zz-named-2995", orgRole: "MEMBER", email: "nakul17+zz-2995-named@aplyd.com", deactivatedAt: null, emailVerifiedAt: new Date() };

const fake = vi.hoisted(() => {
  const tx = {
    user: { update: async () => ({}) },
    session: { updateMany: async () => ({ count: 0 }) },
  };
  return {
    tx,
    db: {
      user: { findUnique: async ({ where }: { where: { id: string } }) => fake.users[where.id] ?? null },
      projectMember: { findMany: async () => fake.memberships },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
    users: {} as Record<string, unknown>,
    memberships: [] as unknown[],
    /** Every releasePerson call, in order: a hidden deal's tasks must still be released. */
    released: [] as string[],
    /** Who each project's tasks were handed to, so a redacted count cannot hide a skipped release. */
    assignees: [] as { projectId: string; newAssigneeId: string }[],
    /** Tasks released per project, so a leaked count is visible as a wrong total. */
    movedByProject: {} as Record<string, number>,
    /** Projects where the named person is already an active LEADER/EDITOR, so nothing falls back there. */
    namedOn: new Set<string>(),
  };
});

vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/access", async (orig) => ({
  ...(await orig<typeof import("../src/lib/access")>()),
  leaderId: async () => "zz-leader-2995",
  // The named person is on none of these projects unless a test says so, so every one falls back.
  activeMember: async (_tx: unknown, projectId: string) => (fake.namedOn.has(projectId) ? { userId: NAMED.id } : null),
}));
vi.mock("@/lib/people", () => ({
  releasePerson: async (_tx: unknown, o: { projectId: string; newAssigneeId: string }) => {
    fake.released.push(o.projectId);
    fake.assignees.push({ projectId: o.projectId, newAssigneeId: o.newAssigneeId });
    return { moved: fake.movedByProject[o.projectId] ?? 0 };
  },
}));
vi.mock("@/lib/notify", () => ({ auditTx: async () => {}, notify: async () => {} }));

const { deactivate } = await import("../src/lib/team");

fake.users = { [TARGET.id]: TARGET, [NAMED.id]: NAMED };
fake.memberships = [DEAL, PLAIN];
// The deal holds more tasks than the visible project, so counting it would be unmistakable.
fake.movedByProject = { [DEAL.projectId]: 3, [PLAIN.projectId]: 2 };

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => { fake.released.length = 0; fake.assignees.length = 0; fake.namedOn.clear(); });

async function run(mode: string, orgRole: "ADMIN" | "SUPER_ADMIN") {
  vi.stubEnv("CRM_VISIBLE", mode);
  return deactivate({ id: "zz-actor-2995", orgRole }, TARGET.id, NAMED.id);
}

describe("qa:TC missing APL-2995 SHO-3029 deactivate hides deals the caller cannot see", () => {
  it("qa:TC missing D1: an admin under CRM_VISIBLE=off gets the plain project only", async () => {
    const res = await run("off", "ADMIN");
    expect(res.fellBack).toEqual([PLAIN.project.name]);
    expect(JSON.stringify(res)).not.toContain(DEAL.project.name);
    expect(JSON.stringify(res)).not.toContain(DEAL.projectId);
  });

  it("qa:TC missing D1: the Super Admin under CRM_VISIBLE=off gets no deal name", async () => {
    const res = await run("off", "SUPER_ADMIN");
    expect(res.fellBack).toEqual([PLAIN.project.name]);
    expect(JSON.stringify(res)).not.toContain(DEAL.project.name);
    expect(JSON.stringify(res)).not.toContain(DEAL.projectId);
  });

  // SHO-3029: `moved` is what the Team page's summary shows. Counting the deal's 3 tasks would tell
  // this admin that a deal exists, even though every deal name and id is kept out of the body.
  it("qa:TC missing SHO-3029: the moved count leaves out tasks on a hidden deal", async () => {
    const res = await run("off", "ADMIN");
    expect(res.moved).toBe(fake.movedByProject[PLAIN.projectId]);
    expect(res.moved).not.toBe(fake.movedByProject[DEAL.projectId] + fake.movedByProject[PLAIN.projectId]);
    expect(JSON.stringify(res)).not.toContain('"moved":5');
  });

  // SHO-3029, the other branch: the named person IS on the hidden deal, so nothing falls back for it and
  // `fellBack` never mentions the deal at all. If the count still included its tasks, `moved` alone would
  // say a deal with 3 tasks exists; the deal's tasks must still go to the person the caller named.
  it("qa:TC missing SHO-3029: the count leaves a hidden deal out even when the named person is on it", async () => {
    fake.namedOn.add(DEAL.projectId);
    const res = await run("off", "ADMIN");
    expect(res.fellBack).toEqual([PLAIN.project.name]);
    expect(res.moved).toBe(fake.movedByProject[PLAIN.projectId]);
    expect(fake.assignees.find((a) => a.projectId === DEAL.projectId)?.newAssigneeId).toBe(NAMED.id);
    expect(JSON.stringify(res)).not.toContain(DEAL.project.name);
  });

  it("qa:TC missing D1 SHO-3029: hidden deals still move their tasks to their own Leader", async () => {
    const res = await run("off", "ADMIN");
    // Both projects were released, so the hidden deal was not skipped; only the count was redacted.
    expect([...fake.released].sort()).toEqual([DEAL.projectId, PLAIN.projectId].sort());
    expect(res.moved).toBe(fake.movedByProject[PLAIN.projectId]);
  });

  // 2f92bfc left the `reassign: "leaders"` branch uncovered: both its cases name a person, so
  // `fellBack` is populated and the deal name is kept out there. With "leaders" nothing is named, so
  // `fellBack` is empty by construction and `moved` is the only field that could still leak the deal.
  it("qa:TC missing SHO-3029: the count leaves a hidden deal out when the tasks go to each Leader", async () => {
    vi.stubEnv("CRM_VISIBLE", "off");
    const res = await deactivate({ id: "zz-actor-2995", orgRole: "ADMIN" }, TARGET.id, "leaders");
    expect(res.fellBack).toEqual([]);
    expect(res.moved).toBe(fake.movedByProject[PLAIN.projectId]);
    expect([...fake.released].sort()).toEqual([DEAL.projectId, PLAIN.projectId].sort());
    expect(fake.assignees.every((a) => a.newAssigneeId === "zz-leader-2995")).toBe(true);
  });

  it("qa:TC missing D1 SHO-3029: callers who can see the CRM are unchanged under all and admins (on is all)", async () => {
    for (const mode of ["all", "admins"]) {
      fake.released.length = 0;
      const res = await run(mode, "ADMIN");
      expect(res.fellBack, `CRM_VISIBLE=${mode}`).toEqual([DEAL.project.name, PLAIN.project.name]);
      expect(res.moved, `CRM_VISIBLE=${mode}`).toBe(fake.movedByProject[DEAL.projectId] + fake.movedByProject[PLAIN.projectId]);
      expect([...fake.released].sort(), `CRM_VISIBLE=${mode}`).toEqual([DEAL.projectId, PLAIN.projectId].sort());
    }
  });
});
