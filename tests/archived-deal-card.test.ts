// APL-2659: a rebuilt change card for an archived deal must not quote the deal name.
// Confirm of that card already returns 409 and writes nothing; this only covers the label.
import { describe, expect, it } from "vitest";
import { account, admin, istDate, project, superAdmin, task } from "./helpers";
import { actor, db } from "./concierge-helpers";
import { buildCard } from "../src/lib/concierge/changes";

async function deal(leaderId: string, who: Awaited<ReturnType<typeof admin>>, tag: string) {
  const pipe = (await who.c.get("/api/deals/pipelines")).json.pipelines.find((p: { key: string }) => p.key === "DEAL_PROACTIVE");
  const orgId = (await who.c.post("/api/orgs", { name: `Org ${tag}` })).json.organisation.id as string;
  const name = `Deal ${tag}`;
  const made = await who.c.post("/api/deals", {
    name, organisationId: orgId, pipelineId: pipe.id, leaderId, whyPursue: "fit",
    nextStep: { title: `Step ${tag}`, dueDate: istDate(3) },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.deal.id as string;
  const step = await db.task.findFirstOrThrow({ where: { projectId: id, deletedAt: null }, select: { id: true, title: true } });
  return { id, name, step };
}

describe("archived deal change card label (APL-2659)", () => {
  it("leaves the deal name out of the label and still marks the write read-only", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa, "archcard");
    const tag = `archcard${Date.now()}`;
    const { id, name, step } = await deal(ad.id, ad, tag);
    expect((await ad.c.post(`/api/projects/${id}/archive`)).status).toBe(200);

    const built = await buildCard(actor(ad, "ADMIN"), [{ k: "task.edit", taskId: step.id, title: `Renamed ${tag}` }]);
    expect(built.card.changes[0].label).toBe(step.title);
    expect(built.card.changes[0].label).not.toContain(name);
    expect(built.card.title).not.toContain(name);
    expect(JSON.stringify(built.card)).not.toContain(name);
    expect(built.card).toMatchObject({ canConfirm: false, blockedReason: "This project is archived and read-only." });
    expect((await db.task.findUniqueOrThrow({ where: { id: step.id } })).title).toBe(step.title);
  });

  it("still quotes a live deal, and an archived project that is not a deal", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa, "livecard");
    const tag = `livecard${Date.now()}`;
    const live = await deal(ad.id, ad, tag);
    const liveCard = await buildCard(actor(ad, "ADMIN"), [{ k: "task.edit", taskId: live.step.id, title: `Renamed ${tag}` }]);
    expect(liveCard.card.changes[0].label).toBe(`${live.step.title} (${live.name})`);

    const member = await account("archproj");
    const p = await project(ad, member);
    const titled = await ad.c.get(`/api/projects/${p.id}`);
    const projectName = titled.json.project.name as string;
    const taskId = await task(ad, p.id, { title: `Project step ${tag}` });
    expect((await ad.c.post(`/api/projects/${p.id}/archive`)).status).toBe(200);
    const archived = await buildCard(actor(ad, "ADMIN"), [{ k: "task.edit", taskId, title: `Renamed project ${tag}` }]);
    expect(archived.card.changes[0].label).toBe(`Project step ${tag} (${projectName})`);
    expect(archived.card.blockedReason).toBe("This project is archived and read-only.");
  });
});
