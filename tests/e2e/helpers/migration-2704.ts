import { BASE_URL, expect, zz, type Later, type Who } from "../support";
import { archiveProject } from "./migration-2731";

/** Current archive payloads, with cleanup registered before the next fixture write. */
export async function newDeal(leader: Who, later: Later, label: string, members: Who[] = []) {
  const pipes = await leader.api.get("/api/deals/pipelines");
  expect(pipes.status, JSON.stringify(pipes.json)).toBe(200);
  const pipe = (pipes.json.pipelines as { id: string; key: string }[]).find(p => p.key === "DEAL_PROACTIVE");
  expect(pipe, "the proactive deal pipeline").toBeTruthy();
  const org = await leader.api.post("/api/orgs", { name: zz(`${label} org`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => leader.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const name = zz(`${label} deal`);
  const dueDate = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const deal = await leader.api.post("/api/deals", { name, organisationId: orgId, pipelineId: pipe!.id, leaderId: leader.user.id, whyPursue: "ZZ-TEST", nextStep: { title: zz("first step"), dueDate } });
  expect(deal.status, JSON.stringify(deal.json)).toBe(201);
  const id = deal.json.deal.id as string;
  later(() => archiveProject(leader.api, id, leader.user.id));
  for (const member of members) expect((await leader.api.post(`/api/projects/${id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  return { id, name };
}

/** Only disposable, explicitly named ZZ-TEST accounts on a loopback QA server may clear their test chat. */
export async function cleanChat(who: Who, later: Later) {
  expect(["127.0.0.1", "localhost"]).toContain(new URL(BASE_URL).hostname);
  expect(who.user.name).toMatch(/^ZZ-TEST\b/);
  const clear = async () => {
    const result = await who.api.del("/api/concierge/messages");
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    const thread = await who.api.get("/api/concierge/state");
    expect(thread.status, JSON.stringify(thread.json)).toBe(200);
    expect(thread.json.messages).toEqual([]);
  };
  await clear();
  later(clear);
}
