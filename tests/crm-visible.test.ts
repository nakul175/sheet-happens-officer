// The CRM_VISIBLE lever (SHO-BUG-2): with `off` no deal, deal task or stage reaches My tasks, search, the task routes or the
// concierge; with `admins` the same for everyone but Admins. The server runs with the default `all`, so these call src/lib
// directly (same database) and flip process.env.CRM_VISIBLE in this process; `crmMode()` reads it at call time.
import { describe, expect, it } from "vitest";
import { account, admin, istDate, project, superAdmin, task } from "./helpers";
import { actor } from "./concierge-helpers";
import type { Actor } from "../src/lib/access";
import { crmMode } from "../src/lib/crm";
import { getTask, listTasks, myTasks } from "../src/lib/tasks";
import { getProject } from "../src/lib/projects";
import { search } from "../src/lib/search";
import { findTasks, listProjects, myTasks as conciergeMyTasks, projectTasks } from "../src/lib/concierge/reads";

const flat = (g: Awaited<ReturnType<typeof myTasks>>) => [...g.overdue, ...g.next7, ...g.later] as { id: string }[];

async function withMode(mode: string, fn: () => Promise<void>) {
  const prev = process.env.CRM_VISIBLE;
  process.env.CRM_VISIBLE = mode;
  try { await fn(); } finally { if (prev === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = prev; }
}

describe("CRM_VISIBLE lever (SHO-BUG-2)", () => {
  it("hides deals and their tasks everywhere when off, from non-admins when admins, and from nobody when all", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa, "cvadmin");
    const lead = await account("cvlead");
    const ed = await account("cved");
    const tag = `cvtag${Date.now()}`;
    // A deal led by `lead` with `ed` as Editor holding one of its tasks, and a plain project where `ed` holds a task too.
    const pipe = (await lead.c.get("/api/deals/pipelines")).json.pipelines.find((p: { key: string }) => p.key === "DEAL_PROACTIVE");
    const orgId = (await lead.c.post("/api/orgs", { name: `Org ${tag}` })).json.organisation.id;
    const made = await lead.c.post("/api/deals", { name: `Deal ${tag}`, organisationId: orgId, pipelineId: pipe.id, leaderId: lead.id, whyPursue: "fit", nextStep: { title: "First step", dueDate: istDate(3) } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const dealId = made.json.deal.id as string;
    expect((await lead.c.post(`/api/projects/${dealId}/members`, { userId: ed.id, role: "EDITOR" })).status).toBe(201);
    const dealTask = await task(ed, dealId, { title: `Deal step ${tag}`, dueDate: istDate(2) });
    const p = await project(lead, lead, [{ who: ed }]);
    const plainTask = await task(ed, p.id, { title: `Plain step ${tag}`, dueDate: istDate(2) });

    const me = actor(ed);
    const adm = actor(ad, "ADMIN");
    const sees = async (u: Actor) => {
      const found = await search(u, tag, false);
      return {
        my: flat(await myTasks(u)).some((t) => t.id === dealTask),
        searchTask: found.tasks.some((t) => t.id === dealTask),
        searchProject: found.projects.some((x) => x.id === dealId),
        conciergeMy: (await conciergeMyTasks(u, "all_open")).tasks.some((t) => t.id === dealTask),
        conciergeFind: (await findTasks(u, tag)).tasks.some((t) => t.id === dealTask),
        conciergeList: (await listProjects(u, tag)).some((x) => x.id === dealId),
      };
    };
    const nothing = { my: false, searchTask: false, searchProject: false, conciergeMy: false, conciergeFind: false, conciergeList: false };
    const notFound = { status: 404 };

    // Default: the member sees their deal work everywhere.
    expect(crmMode()).toBe("all");
    expect(await sees(me)).toEqual({ my: true, searchTask: true, searchProject: true, conciergeMy: true, conciergeFind: true, conciergeList: true });

    await withMode("off", async () => {
      expect(crmMode()).toBe("off");
      expect(await sees(me)).toEqual(nothing);
      await expect(getTask(me, dealTask)).rejects.toMatchObject(notFound);
      await expect(listTasks(me, dealId, {})).rejects.toMatchObject(notFound);
      await expect(getProject(me, dealId)).rejects.toMatchObject(notFound);
      await expect(projectTasks(me, dealId)).rejects.toMatchObject(notFound);
      // Off means nobody, Admins included.
      expect(await sees(adm)).toEqual(nothing);
      await expect(getTask(adm, dealTask)).rejects.toMatchObject(notFound);
      // Plain project work is untouched.
      expect(flat(await myTasks(me)).some((t) => t.id === plainTask)).toBe(true);
      expect((await search(me, tag, false)).tasks.some((t) => t.id === plainTask)).toBe(true);
      expect((await conciergeMyTasks(me, "all_open")).tasks.some((t) => t.id === plainTask)).toBe(true);
      expect((await getTask(me, plainTask)).id).toBe(plainTask);
    });

    await withMode("admins", async () => {
      expect(await sees(me)).toEqual(nothing);
      await expect(getTask(me, dealTask)).rejects.toMatchObject(notFound);
      await expect(listTasks(me, dealId, {})).rejects.toMatchObject(notFound);
      // An Admin is not a member, so My tasks has nothing of theirs; everything else shows the deal.
      expect(await sees(adm)).toEqual({ my: false, searchTask: true, searchProject: true, conciergeMy: false, conciergeFind: true, conciergeList: true });
      expect((await getTask(adm, dealTask)).id).toBe(dealTask);
      expect((await listTasks(adm, dealId, {})).sections.length).toBeGreaterThan(0);
    });

    // Back to the default, the member sees it all again.
    expect(crmMode()).toBe("all");
    expect(await sees(me)).toEqual({ my: true, searchTask: true, searchProject: true, conciergeMy: true, conciergeFind: true, conciergeList: true });
    expect((await getTask(me, dealTask)).id).toBe(dealTask);
  });
});
