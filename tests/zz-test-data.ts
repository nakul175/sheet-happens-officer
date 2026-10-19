// ZZ-TEST people and projects for one test file, and their cleanup through the API (APL-2721).
// Names start with ZZ-TEST and addresses are nakul17+ aliases. cleanUp() is the same sequence as
// tests/e2e/stories/APL-2522.spec.ts: the Super Admin joins each project, takes the Leader role,
// archives it, then deactivates each person. Archived projects still count as leaderships, so the
// handover has to come first.
import { expect } from "vitest";
import { account, superAdmin, type Account } from "./helpers";

export type ZzProject = { id: string; name: string; todo: string; doing: string; done: string };

export function zzTestData(tag: string) {
  const run = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  let seq = 0;
  const people: Account[] = [];
  const projectIds: string[] = [];

  /** A throwaway person: display name ZZ-TEST <role>, address nakul17+zz-<tag>-<run>-…@aplyd.com (unique per run). */
  async function person(role: string) {
    const n = seq++;
    const slug = role.toLowerCase().replace(/[^a-z0-9]+/g, "") || "user";
    const who = await account(`ZZ-TEST ${role}`, `nakul17+zz-${tag}-${run}-${slug}-${n}@aplyd.com`);
    people.push(who);
    return who;
  }

  /** A ZZ-TEST project led by `leader`. */
  async function project(leader: Account): Promise<ZzProject> {
    const name = `ZZ-TEST ${run}-${seq++}`;
    const r = await leader.c.post("/api/projects", { name, leaderId: leader.id });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.project.id as string;
    projectIds.push(id);
    const p = await leader.c.get(`/api/projects/${id}`);
    const sections = p.json.project.sections as { id: string; name: string; isDone: boolean }[];
    return { id, name, todo: sections[0].id, doing: sections[1].id, done: sections.find((s) => s.isDone)!.id };
  }

  /** Archives every project and deactivates every person made here. Returns what went wrong, if anything. */
  async function cleanUp() {
    const sa = await superAdmin();
    const problems: string[] = [];
    for (const id of projectIds) {
      const added = await sa.c.post(`/api/projects/${id}/members`, { userId: sa.id, role: "EDITOR" });
      if (added.status !== 201 && !(added.status === 409 && /already a member/.test(added.json?.error ?? ""))) {
        problems.push(`add member ${id}: ${added.status} ${JSON.stringify(added.json)}`);
      }
      const led = await sa.c.post(`/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
      if (led.status !== 200 && !(led.status === 400 && /already the Leader/.test(led.json?.error ?? ""))) {
        problems.push(`change leader ${id}: ${led.status} ${JSON.stringify(led.json)}`);
      }
      const archived = await sa.c.post(`/api/projects/${id}/archive`);
      if (archived.status !== 200) problems.push(`archive ${id}: ${archived.status} ${JSON.stringify(archived.json)}`);
    }
    for (const who of people) {
      const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
      if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) {
        problems.push(`deactivate ${who.email}: ${off.status} ${JSON.stringify(off.json)}`);
      }
    }
    return problems;
  }

  return { person, project, cleanUp };
}
