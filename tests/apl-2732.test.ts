// APL-2732: POST /api/team/[id]/deactivate checks that the caller is an Admin before it reads the body.
// A Member gets 403 whatever the body; an Admin with a bad body still gets today's 400.
// Throwaway people use ZZ-TEST names and nakul17+ aliases; afterAll deactivates them.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, admin, BASE, superAdmin, type Account } from "./helpers";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
const people: Account[] = [];
const FORBIDDEN = { error: "You cannot deactivate this person." };

async function zz(role: string) {
  const who = await account(`ZZ-TEST ${role} ${RUN}`, `nakul17+zz-2732-${RUN}-${role.toLowerCase()}-${seq++}@aplyd.com`);
  people.push(who);
  return who;
}

/** Sends the raw text as the body, so a malformed body reaches the server unchanged. */
async function raw(who: Account, path: string, text: string) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", cookie: who.c.cookie }, body: text });
  return { status: res.status, text: await res.text() };
}

function noSchemaLeak(text: string) {
  expect(text).not.toContain("Validation failed");
  expect(text).not.toContain("issues");
  expect(text).not.toContain("reassign");
  for (const role of ["MEMBER", "ADMIN", "SUPER_ADMIN"]) expect(text).not.toContain(role);
}

let sa: Account;
let memberA: Account;
let memberB: Account;

beforeAll(async () => {
  sa = await superAdmin();
  memberA = await zz("MemberA");
  memberB = await zz("MemberB");
});

afterAll(async () => {
  for (const who of people) {
    const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
    expect([200, 409]).toContain(off.status);
  }
});

describe("qa:TC missing APL-2732 deactivate checks the Admin role before the body", () => {
  it("qa:TC missing AC1: a Member sending {} gets 403 with no validation details", async () => {
    const r = await raw(memberA, `/api/team/${memberB.id}/deactivate`, "{}");
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text)).toEqual(FORBIDDEN);
    noSchemaLeak(r.text);
  });

  it("qa:TC missing AC1: a Member sending a malformed body gets 403 with no validation details", async () => {
    const r = await raw(memberA, `/api/team/${memberB.id}/deactivate`, "{");
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text)).toEqual(FORBIDDEN);
    noSchemaLeak(r.text);
  });

  it("qa:TC missing AC1: a Member sending a wrongly typed reassign gets 403 with no validation details", async () => {
    const r = await raw(memberA, `/api/team/${memberB.id}/deactivate`, JSON.stringify({ reassign: 7 }));
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text)).toEqual(FORBIDDEN);
    noSchemaLeak(r.text);
  });

  it("qa:TC missing AC2: the Super Admin sending {} still gets today's 400 validation body", async () => {
    const r = await sa.c.post(`/api/team/${memberB.id}/deactivate`, {});
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Validation failed");
    expect(r.json.issues).toEqual([expect.objectContaining({ path: ["reassign"] })]);
  });

  it("qa:TC missing AC2: the Super Admin sending a malformed body still gets today's 400", async () => {
    const r = await raw(sa, `/api/team/${memberB.id}/deactivate`, "{");
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text)).toEqual({ error: "Body must be valid JSON" });
  });

  it("qa:TC missing AC2: an Admin sending {} still gets today's 400 validation body", async () => {
    const adm = await admin(sa, `zz2732adm${RUN}`);
    people.push(adm);
    const r = await adm.c.post(`/api/team/${memberB.id}/deactivate`, {});
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Validation failed");
  });

  it("qa:TC missing AC3: a Member sending a valid body gets the same 403 as before, and the target stays active", async () => {
    const r = await memberA.c.post(`/api/team/${memberB.id}/deactivate`, { reassign: "leaders" });
    expect(r.status).toBe(403);
    expect(r.json).toEqual(FORBIDDEN);
    const person = await sa.c.get(`/api/team/${memberB.id}`);
    expect(person.status).toBe(200);
    expect(person.json.person.status).toBe("ACTIVE");
  });

  it("qa:TC missing AC3: the Super Admin's valid deactivate still succeeds", async () => {
    const target = await zz("Target");
    const r = await sa.c.post(`/api/team/${target.id}/deactivate`, { reassign: "leaders" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ moved: 0, fellBack: [] });
  });

  it("qa:TC missing no session still gets 401 before the body is read", async () => {
    const res = await fetch(`${BASE}/api/team/${memberB.id}/deactivate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in" });
  });
});
