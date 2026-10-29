// APL-2995. deactivate's `fellBack` must not name a deal the caller cannot see.
// No server and no database: @/lib/db, the membership helpers, releasePerson and auditTx are faked here,
// so nothing is written anywhere. crmVisible is the real one and reads CRM_VISIBLE at call time.
// Names are ZZ-TEST.
import { afterEach, describe, expect, it, vi } from "vitest";

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
  };
});

vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/access", async (orig) => ({
  ...(await orig<typeof import("../src/lib/access")>()),
  leaderId: async () => "zz-leader-2995",
  activeMember: async () => null, // the named person is on none of these projects, so every one falls back
}));
const release = vi.hoisted(() => vi.fn(async () => ({ moved: 1 })));
vi.mock("@/lib/people", () => ({ releasePerson: release }));
vi.mock("@/lib/notify", () => ({ auditTx: async () => {}, notify: async () => {} }));

const { deactivate } = await import("../src/lib/team");

fake.users = { [TARGET.id]: TARGET, [NAMED.id]: NAMED };
fake.memberships = [DEAL, PLAIN];

afterEach(() => vi.unstubAllEnvs());

async function run(mode: string, orgRole: "ADMIN" | "SUPER_ADMIN") {
  vi.stubEnv("CRM_VISIBLE", mode);
  return deactivate({ id: "zz-actor-2995", orgRole }, TARGET.id, NAMED.id);
}

describe("qa:TC missing APL-2995 deactivate fellBack hides deals the caller cannot see", () => {
  it("qa:TC missing D1: an admin under CRM_VISIBLE=off gets the plain project only", async () => {
    const res = await run("off", "ADMIN");
    expect(res.fellBack).toEqual([PLAIN.project.name]);
    expect(JSON.stringify(res)).not.toContain(DEAL.project.name);
    expect(JSON.stringify(res)).not.toContain(DEAL.projectId);
  });

  it("qa:TC missing D1: the Super Admin under CRM_VISIBLE=off gets no deal name", async () => {
    const res = await run("off", "SUPER_ADMIN");
    expect(res.fellBack).toEqual([PLAIN.project.name]);
  });

  it("qa:TC missing D1: hidden deals still move their tasks to the Leader", async () => {
    release.mockClear();
    const res = await run("off", "ADMIN");
    expect(release).toHaveBeenCalledTimes(2);
    expect(res.moved).toBe(1); // The hidden deal must not leak through the returned count.
  });

  it("qa:TC missing D1: callers who can see the CRM are unchanged under all and admins (on is all)", async () => {
    for (const mode of ["all", "admins"]) {
      const res = await run(mode, "ADMIN");
      expect(res.fellBack, `CRM_VISIBLE=${mode}`).toEqual([DEAL.project.name, PLAIN.project.name]);
    }
  });
});
