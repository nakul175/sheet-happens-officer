// SHO-BUG-5 A deal's first next step is created without a task.created row or a TASK_ASSIGNED notice  (Linear APL-2612)
// No numbered ACs in the issue; follows its "Expected" and "Test" paragraphs.
import { test, expect, zz } from "../support";

async function newDeal(admin: any, leaderId: string, later: (f: () => Promise<unknown>) => void, label: string) {
  const org = await admin.api.post("/api/orgs", { name: zz(`org ${label}`) });
  expect(org.status).toBe(201);
  later(() => admin.api.post(`/api/orgs/${org.json.organisation.id}/archive`, { archive: true }));
  const pro = ((await admin.api.get("/api/deals/pipelines")).json.pipelines as any[]).find((p) => p.key === "DEAL_PROACTIVE");
  const step = zz(`first step ${label}`);
  const d = await admin.api.post("/api/deals", {
    name: zz(`deal ${label}`), organisationId: org.json.organisation.id, pipelineId: pro.id, leaderId,
    whyPursue: "ZZ-TEST first step check", nextStep: { title: step, dueDate: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10) },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  later(() => admin.api.post(`/api/projects/${d.json.deal.id}/archive`));
  return { id: d.json.deal.id as string, step };
}

test("The first next step leaves a 'task.created' row in the deal's Activity", async ({ admin, later }) => {
  const d = await newDeal(admin, admin.user.id, later, "activity");
  const items = (await admin.api.get(`/api/projects/${d.id}/activity`)).json.items as { what: string }[];
  expect(items.some((i) => i.what.includes(d.step) && /^added /.test(i.what)), `Activity has an 'added "${d.step}"' row`).toBe(true);
});

test("When the Leader is someone else, they get an 'assigned you' notice for the first step", async ({ admin, member, later }) => {
  const d = await newDeal(admin, member.user.id, later, "notice");
  const items = (await member.api.get("/api/notifications")).json.items as { text: string }[];
  expect(items.some((n) => n.text.includes("assigned you") && n.text.includes(d.step)), "TASK_ASSIGNED notice for the first step").toBe(true);
});
