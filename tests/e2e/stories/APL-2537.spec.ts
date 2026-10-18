// SHO-US-12.1 Create a deal (Linear APL-2537).
// One test per acceptance criterion. Sign-in is login("ADMIN") / login("MEMBER") via the fixtures.
// Deals and organisations are ZZ-TEST and archived afterwards. A ghost leader is deactivated and cannot sign in.
import { test, expect, zz } from "../support";
import { getTask, ghost, ymd } from "../g2";
import { pipelines } from "../helpers/deal-board";
import { activity, audit, createDeal, createOrg, dealBody, notices, projectOf } from "../helpers/claude-a";

test("APL-2537 > AC1: one create puts the deal in the first stage with its Leader, Editor, next step, notice and both logs", async ({ admin, member, later }) => {
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "create org");
  const step = zz("first step");
  const name = zz("created deal");
  const deal = await createDeal(admin, later, dealBody({ name, organisationId: org.id, pipelineId: pipes.pro.id, leaderId: member.user.id, step }));
  const project = await projectOf(admin, deal.id);
  expect(project.type).toBe("DEAL");
  expect(project.deal.stage.name).toBe(pipes.pro.stages[0].name);
  expect(project.deal.organisation.id).toBe(org.id);
  expect(project.sections.map((s: { name: string }) => s.name)).toEqual(["To do", "In progress", "Done"]);
  const role = (id: string) => (project.members as { userId: string; role: string }[]).find((m) => m.userId === id)?.role;
  expect(role(member.user.id), "the chosen Leader is the Leader").toBe("LEADER");
  expect(role(admin.user.id), "the creator is an Editor when someone else leads; an Admin is not made Leader").toBe("EDITOR");
  const task = await getTask(member, project.deal.nextStep.id as string);
  expect(task.title).toBe(step);
  expect(task.assignee.id).toBe(member.user.id);
  expect((await activity(admin, deal.id)).some((row) => row.what === `created the deal "${name}"`)).toBe(true);
  expect((await notices(member)).some((n) => n.text === `${admin.user.name} made you Leader of "${name}".` && n.href === `/projects/${deal.id}`)).toBe(true);
  expect((await audit(admin, "DEAL_CREATED", admin.user.id)).some((row) => row.target === `Deal "${name}"`)).toBe(true);
});

test("APL-2537 > AC2: creating a deal with no organisation is refused with Choose an organisation", async ({ admin, later }) => {
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "org for refusal");
  const base = dealBody({ name: zz("needs org"), organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id });
  const empty = await admin.api.post("/api/deals", { ...base, organisationId: "" });
  expect(empty.status, JSON.stringify(empty.json)).toBe(400);
  expect(JSON.stringify(empty.json)).toContain("Choose an organisation.");
  const missing = await admin.api.post("/api/deals", { ...base, organisationId: "no-such-org" });
  expect(missing.status, JSON.stringify(missing.json)).toBe(400);
  expect(missing.json.error).toBe("Choose an organisation.");
});

test("APL-2537 > AC3: a Bid with no submission deadline is refused", async ({ admin, later }) => {
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "bid org");
  const body = dealBody({ name: zz("bid deal"), organisationId: org.id, pipelineId: pipes.bid.id, leaderId: admin.user.id });
  const refused = await admin.api.post("/api/deals", body);
  expect(refused.status, JSON.stringify(refused.json)).toBe(400);
  expect(refused.json.error).toBe("A bid needs a submission deadline.");
  const made = await createDeal(admin, later, { ...body, name: zz("bid with deadline"), submissionDeadline: ymd(12) });
  expect((await projectOf(admin, made.id)).deal.details.submissionDeadline).toBe(ymd(12));
});

test("APL-2537 > AC4: an empty value stays empty, and a value keeps its own currency", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "value org");
  const base = dealBody({ name: zz("empty value"), organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id });
  const zero = await admin.api.post("/api/deals", { ...base, value: 0, currency: "INR" });
  expect(zero.status, JSON.stringify(zero.json)).toBe(400);
  const bare = await admin.api.post("/api/deals", { ...base, name: zz("bare value"), value: 500 });
  expect(bare.status, JSON.stringify(bare.json)).toBe(400);

  const empty = await createDeal(admin, later, base);
  expect((await projectOf(admin, empty.id)).deal.details.value).toBeNull();
  const currencies = [
    { code: "INR" as const, amount: 111 },
    { code: "USD" as const, amount: 222 },
    { code: "EUR" as const, amount: 333 },
  ];
  const deals = [];
  for (const c of currencies) {
    deals.push(await createDeal(admin, later, { ...base, name: zz(`value ${c.code}`), value: c.amount, currency: c.code }));
  }
  for (const [i, c] of currencies.entries()) {
    expect((await projectOf(admin, deals[i].id)).deal.details).toMatchObject({ value: c.amount, currency: c.code });
  }
  const cleared = await admin.api.patch(`/api/projects/${deals[0].id}/deal`, { value: null });
  expect(cleared.status, JSON.stringify(cleared.json)).toBe(200);
  expect((await projectOf(admin, deals[0].id)).deal.details.value).toBeNull();

  await admin.page.goto("/deals");
  await expect(admin.page.locator(".dcard", { hasText: empty.name })).toContainText("No value yet");
  await expect(admin.page.locator(".dcard", { hasText: deals[1].name })).toContainText("USD 222");
  await expect(admin.page.locator(".dcard", { hasText: deals[1].name })).not.toContainText("INR");
  await expect(admin.page.locator(".dcard", { hasText: deals[2].name })).toContainText("EUR 333");
  await expect(admin.page.locator(".dcard", { hasText: deals[2].name })).not.toContainText("666");
});

test("APL-2537 > AC5: the same name under the same Buyer is warned, and the member can continue", async ({ admin, later }) => {
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "dup org");
  const name = zz("Dup Deal");
  const first = dealBody({ name, organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id });
  await createDeal(admin, later, first);
  const second = await admin.api.post("/api/deals", { ...first, name: name.replace("Dup", "dup") });
  expect(second.status, JSON.stringify(second.json)).toBe(409);
  expect(second.json.needsConfirm).toBe("duplicate");
  const forced = await createDeal(admin, later, { ...first, name: name.replace("Dup", "dup"), force: true });
  expect(forced.id).not.toBe("");
});

test("APL-2537 > AC6: the Leader must be an active person in the workspace, and is added as Leader", async ({ admin, later }) => {
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "leader org");
  const base = dealBody({ name: zz("led deal"), organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id });
  const gone = await ghost(admin, later, "retired");
  expect((await admin.api.post(`/api/team/${gone.id}/deactivate`, { reassign: "leaders" })).status).toBeLessThan(300);
  const dead = await admin.api.post("/api/deals", { ...base, name: zz("dead leader"), leaderId: gone.id });
  expect(dead.status, JSON.stringify(dead.json)).toBe(400);
  expect(dead.json.error).toBe("Choose an active person as Leader.");
  const outside = await admin.api.post("/api/deals", { ...base, name: zz("outside leader"), leaderId: "not-in-this-workspace" });
  expect(outside.status, JSON.stringify(outside.json)).toBe(400);
  expect(outside.json.error).toBe("Choose an active person as Leader.");

  const deal = await createDeal(admin, later, base);
  const members = (await projectOf(admin, deal.id)).members as { userId: string; role: string }[];
  expect(members.find((m) => m.userId === admin.user.id)?.role).toBe("LEADER");
  expect(members.some((m) => m.role === "VIEWER")).toBe(false);
});
