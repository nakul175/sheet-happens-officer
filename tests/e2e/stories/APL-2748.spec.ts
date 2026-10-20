// APL-2748. The story specs sign in as a fixed pool of already verified nakul17+ aliases: the Super Admin and
// 3 Members in this job's slot (QA_SLOT). No sign-up or verification happens at run time; a missing or
// unverified alias fails with the provisioning step to run (tests/e2e/tools/provision-aliases.ts).
// Pam left no qa:TC id on the issue; each title says "qa:TC missing". Nothing here targets production.
import { test, expect } from "../support";
import { PER_SLOT } from "../helpers/alias-pool";
import { QA_ADMIN_EMAIL, QA_PASS, QA_SLOT, cast, noSecret, qaPerson, signInAlias, track } from "../helpers/qa-alias";

test.describe.configure({ mode: "serial" });

let promotedId = "";
let deactivatedId = "";

test.describe("qa:TC missing APL-2748: the verified alias pool", () => {
  test.beforeAll(() => {
    if (!QA_PASS) throw new Error("Set SHO_QA_PASS (the password for the nakul17+ aliases) from the CI or staging secrets.");
  });

  test("qa:TC missing AC1: the Super Admin and every Member in this slot sign in as verified, active accounts", async ({ browser, later }) => {
    const labels = Array.from({ length: PER_SLOT }, (_, i) => `pool ${i + 1}`);
    const { admin, people } = await cast(browser, later, labels);
    expect(admin.user.email).toBe(QA_ADMIN_EMAIL);
    expect(admin.user.orgRole).toBe("SUPER_ADMIN");
    expect(people.map((p) => p.user.email)).toEqual(labels.map((_, i) => qaPerson(i + 1).email));
    expect(new Set(people.map((p) => p.user.id)).size).toBe(PER_SLOT);
    const team = await admin.api.get("/api/team");
    expect(team.status).toBe(200);
    for (const p of people) {
      expect(p.user.orgRole, String(p.user.email)).toBe("MEMBER");
      const row = (team.json.people as { id: string; status: string }[]).find((r) => r.id === p.user.id);
      expect(row?.status, `${String(p.user.email)} in slot ${QA_SLOT}`).toBe("ACTIVE");
    }
    await people[0].page.goto("/");
    await expect(people[0].page).not.toHaveURL(/\/signin/);
  });

  test("qa:TC missing AC1: a pool Member a spec promotes is put back to Member by the clean-up", async ({ browser, later }) => {
    const { admin, people: [person] } = await cast(browser, later, ["promoted"]);
    const up = await admin.api.patch(`/api/team/${person.user.id}`, { orgRole: "ADMIN" });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    promotedId = String(person.user.id);
  });

  test("qa:TC missing AC1: the promoted Member is a Member again before anyone else signs in", async ({ browser, later }) => {
    expect(promotedId, "the previous test ran").not.toBe("");
    const admin = await signInAlias(browser, QA_ADMIN_EMAIL);
    track(later, admin.ctx);
    const seen = await admin.who.api.get(`/api/team/${promotedId}`);
    expect(seen.status).toBe(200);
    expect(seen.json.person.orgRole).toBe("MEMBER");
  });

  test("qa:TC missing AC1: a pool Member a spec deactivates is reactivated by the clean-up", async ({ browser, later }) => {
    const { admin, people: [, leaver] } = await cast(browser, later, ["stays", "leaver"]);
    const gone = await admin.api.post(`/api/team/${leaver.user.id}/deactivate`, { reassign: "leaders" });
    expect(gone.status, JSON.stringify(gone.json)).toBe(200);
    deactivatedId = String(leaver.user.id);
  });

  test("qa:TC missing AC1: the deactivated Member is active again and can sign in", async ({ browser, later }) => {
    expect(deactivatedId, "the previous test ran").not.toBe("");
    const admin = await signInAlias(browser, QA_ADMIN_EMAIL);
    track(later, admin.ctx);
    const seen = await admin.who.api.get(`/api/team/${deactivatedId}`);
    expect(seen.status).toBe(200);
    expect(seen.json.person.status).toBe("ACTIVE");
    const back = await signInAlias(browser, qaPerson(2).email);
    track(later, back.ctx);
    expect(String(back.who.user.id)).toBe(deactivatedId);
  });

  test("qa:TC missing AC2: the session the pool password opens never echoes it", async ({ browser, later }) => {
    const signed = await signInAlias(browser, qaPerson(1).email);
    track(later, signed.ctx);
    const me = await signed.ctx.request.get("/api/auth/me");
    const body = await me.text();
    expect(me.status()).toBe(200);
    noSecret(body);
    expect(JSON.stringify(signed.who.user)).not.toContain(QA_PASS);
  });
});
