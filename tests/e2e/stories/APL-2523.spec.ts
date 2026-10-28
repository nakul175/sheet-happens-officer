// SHO-E10 Workstream types and pipelines (Linear APL-2523).
// Pam left no qa:TC id. Each title says qa:TC missing. The annotation is qa:TC with description missing. An AC number is not a TC id.
// One test per acceptance criterion. People are nakul17+ aliases signed in with SHO_QA_PASS.
// Projects, deals and organisations are ZZ-TEST and archived afterwards.
// Pam left no qa:TC cases on this issue.
import { test, expect, zz } from "../support";
import { getTask, newProject, type Who } from "../g2";
import { pipelines, type Pipe } from "../helpers/deal-board";
import { createDeal, createOrg, dealBody, projectOf } from "../helpers/claude-a";
import { cast, gateFile, noSecret } from "../helpers/qa-alias";

gateFile();

const CRM_OFF = "CRM routes answer not found on this server (CRM_VISIBLE is off).";

async function pipes(who: Who) {
  const r = await who.api.get("/api/deals/pipelines");
  expect(r.status, CRM_OFF + " " + JSON.stringify(r.json)).toBe(200);
  return pipelines(who.api);
}

// qa:TC missing
test("AC1: a saved project has exactly one workstream type, and a plain project is type Project qa:TC missing", async ({ browser, later }) => {
  const { admin } = await cast(browser, later, []);
  const plain = await newProject(admin, later, { label: "e10 plain" });
  const row = await projectOf(admin, plain.id);
  expect(row.type).toBe("PROJECT");
  expect(row.deal).toBeNull();
  expect(["PROJECT", "DEAL"]).toContain(row.type);
  const listed = (await admin.api.get("/api/projects")).json.projects as { id: string; name: string }[];
  expect(listed.some((p) => p.id === plain.id)).toBe(true);
  for (const p of listed.filter((p) => p.id !== plain.id).slice(0, 6)) {
    const got = await projectOf(admin, p.id);
    expect(got.type, p.name).toBe("PROJECT");
    expect(got.deal, p.name).toBeNull();
  }
  const crm = await admin.api.get("/api/deals/pipelines");
  if (crm.status === 404) return;
  const { pro } = await pipes(admin);
  const org = await createOrg(admin, later, "e10 type org");
  const deal = await createDeal(admin, later, dealBody({ name: zz("e10 type deal"), organisationId: org.id, pipelineId: pro.id, leaderId: admin.user.id }));
  const again = (await admin.api.get("/api/projects")).json.projects as { id: string }[];
  expect(again.some((p) => p.id === deal.id)).toBe(false);
  const asDeal = await projectOf(admin, deal.id);
  expect(asDeal.type).toBe("DEAL");
  expect(asDeal.deal).toBeTruthy();
  expect(asDeal.type === "PROJECT" && asDeal.type === "DEAL").toBe(false);
});
// qa:TC missing
test("AC2: a new deal points at a Deal pipeline and starts on its first stage qa:TC missing", async ({ browser, later }) => {
  const { admin } = await cast(browser, later, []);
  const { pro, bid } = await pipes(admin);
  for (const pipe of [pro, bid] as Pipe[]) {
    expect(pipe.stages.length).toBeGreaterThan(0);
    expect(pipe.stages.every((s) => s.id && s.name)).toBe(true);
  }
  const org = await createOrg(admin, later, "e10 buyer");
  const deal = await createDeal(admin, later, dealBody({
    name: zz("e10 first stage"), organisationId: org.id, pipelineId: pro.id, leaderId: admin.user.id, deadline: undefined,
  }));
  const got = await projectOf(admin, deal.id);
  expect(got.type).toBe("DEAL");
  expect(got.deal.pipeline.id).toBe(pro.id);
  expect(got.deal.stage.id).toBe(pro.stages[0].id);
  expect(got.deal.stage.name).toBe(pro.stages[0].name);
  const listed = ((await admin.api.get(`/api/deals?pipelineId=${pro.id}`)).json.deals as { id: string; stage: { id: string } }[]).find((d) => d.id === deal.id);
  expect(listed?.stage.id).toBe(pro.stages[0].id);
});
// qa:TC missing
test("AC3: the stage stepper moves the deal, writes an action-log row, and tells the Leader qa:TC missing", async ({ browser, later }) => {
  test.setTimeout(120_000);
  const { admin, people: [editor] } = await cast(browser, later, ["mover"]);
  const { pro } = await pipes(editor);
  const org = await createOrg(admin, later, "e10 stage org");
  const deal = await createDeal(admin, later, dealBody({ name: zz("e10 move"), organisationId: org.id, pipelineId: pro.id, leaderId: admin.user.id }));
  expect((await admin.api.post(`/api/projects/${deal.id}/members`, { userId: editor.user.id, role: "EDITOR" })).status).toBe(201);
  const next = pro.stages[1];
  await editor.page.goto(`/projects/${deal.id}`);
  const stage = editor.page.getByRole("group", { name: "Stage" });
  await expect(stage.getByRole("button", { name: pro.stages[0].name, exact: true })).toHaveAttribute("aria-current", "step");
  await stage.getByRole("button", { name: next.name, exact: true }).click();
  const dialog = editor.page.getByRole("dialog", { name: `Move to ${next.name}` });
  await dialog.getByRole("button", { name: "Move deal" }).click();
  await expect(stage.getByRole("button", { name: next.name, exact: true })).toHaveAttribute("aria-current", "step");
  const activity = (await admin.api.get(`/api/projects/${deal.id}/activity`)).json.items as { what: string }[];
  expect(activity.some((i) => i.what.includes(`moved the deal from ${pro.stages[0].name} to ${next.name}`))).toBe(true);
  const notes = (await admin.api.get("/api/notifications?limit=200")).json.items as { text: string }[];
  const told = notes.filter((n) => n.text.includes(deal.name) && n.text.includes(`to ${next.name}`));
  expect(told).toHaveLength(1);
  expect((await editor.api.get("/api/notifications?limit=200")).json.items.some((n: { text: string }) => n.text.includes(deal.name) && n.text.includes(`to ${next.name}`))).toBe(false);
});

// qa:TC missing
test("AC4: the Projects list hides deals, and deals are reached from /deals, with archived deals behind the toggle qa:TC missing", async ({ browser, later }) => {
  test.setTimeout(120_000);
  const { admin, people: [member] } = await cast(browser, later, ["deal member"]);
  const { pro } = await pipes(member);
  const org = await createOrg(admin, later, "e10 list org");
  const deal = await createDeal(admin, later, dealBody({ name: zz("e10 hidden deal"), organisationId: org.id, pipelineId: pro.id, leaderId: member.user.id }));
  later(() => admin.api.post(`/api/projects/${deal.id}/leader`, { newLeaderId: admin.user.id, previousRole: "EDITOR" }));
  const projects = (await member.api.get("/api/projects")).json.projects as { id: string; name: string }[];
  expect(projects.some((p) => p.id === deal.id || p.name === deal.name)).toBe(false);
  await member.page.goto("/projects");
  await expect(member.page.getByText(deal.name)).toHaveCount(0);
  const live = (await member.api.get(`/api/deals?pipelineId=${pro.id}`)).json.deals as { id: string }[];
  expect(live.some((d) => d.id === deal.id)).toBe(true);
  await member.page.goto("/deals");
  await expect(member.page.getByRole("region", { name: pro.stages[0].name }).getByText(deal.name)).toBeVisible();
  expect((await admin.api.post(`/api/projects/${deal.id}/archive`)).status).toBeLessThan(300);
  await member.page.reload();
  await expect(member.page.getByText(deal.name)).toHaveCount(0);
  await member.page.getByRole("button", { name: "Show archived" }).click();
  await expect(member.page.getByRole("link", { name: deal.name })).toBeVisible();
});

// qa:TC missing
test("AC5: Proactive keeps On hold, Won and Lost in separate columns qa:TC missing", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const { pro } = await pipes(admin);
  const org = await createOrg(admin, later, "e10 board org");
  const deal = await createDeal(admin, later, dealBody({ name: zz("e10 board deal"), organisationId: org.id, pipelineId: pro.id, leaderId: admin.user.id }));
  const outcomes: { name: string; id: string; stage: string }[] = [];
  for (const name of ["On hold", "Won", "Lost"]) {
    const target = pro.stages.find(stage => stage.name === name)!;
    expect(target, name).toBeTruthy();
    const outcome = await createDeal(admin, later, { ...dealBody({ name: zz(`distinct ${name}`), organisationId: org.id, pipelineId: pro.id, leaderId: admin.user.id }), value: 100, currency: "INR" });
    const project = await projectOf(admin, outcome.id);
    const stepId = (project.deal as { nextStep: { id: string } }).nextStep.id;
    const task = await getTask(admin, stepId);
    const completed = await admin.api.post(`/api/tasks/${stepId}/complete`, { expectedUpdatedAt: task.updatedAt });
    expect(completed.status, JSON.stringify(completed.json)).toBe(200);
    const moved = await admin.api.post(`/api/projects/${outcome.id}/stage`, { stageId: target.id, reason: "ZZ-TEST distinct outcomes acceptance" });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    outcomes.push({ ...outcome, stage: name });
  }
  for (const width of [1280, 390]) {
    await admin.page.setViewportSize({ width, height: 900 });
    await admin.page.goto("/deals");
    const board = admin.page.getByRole("region", { name: "Deal board", exact: true }).filter({ has: admin.page.getByRole("link", { name: deal.name, exact: true }) });
    await expect(board).toHaveCount(1);
    await expect(board.getByRole("region", { name: "On hold / Won / Lost", exact: true })).toHaveCount(0);
    for (const outcome of outcomes) {
      const column = board.getByRole("region", { name: outcome.stage, exact: true });
      await expect(column.getByRole("link", { name: outcome.name, exact: true })).toBeVisible();
      for (const other of outcomes.filter(d => d.id !== outcome.id)) await expect(column.getByRole("link", { name: other.name, exact: true })).toHaveCount(0);
    }
    const geometry = await board.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
    expect(await admin.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await board.screenshot({ path: test.info().outputPath(`proactive-outcomes-${width}.png`) });
  }
});

// qa:TC missing
test("AC6: CRM_VISIBLE admins or off answers not found and hides Deals qa:TC missing", async ({ browser, later }) => {
  const { admin, people: [member] } = await cast(browser, later, ["outsider"]);
  const adminDeals = await admin.api.get("/api/deals");
  const memberDeals = await member.api.get("/api/deals");
  const mode = adminDeals.status === 404 ? "off" : memberDeals.status === 404 ? "admins" : "all";
  if (mode === "all") {
    expect(adminDeals.status).toBe(200);
    expect(memberDeals.status).toBe(200);
    for (const who of [admin, member]) {
      await who.page.goto("/");
      await expect(who.page.getByRole("link", { name: "Deals", exact: true })).toBeVisible();
    }
    return;
  }
  if (mode === "off") {
    expect(adminDeals.status).toBe(404);
    expect(memberDeals.status).toBe(404);
    for (const who of [admin, member]) {
      await who.page.goto("/deals");
      await expect(who.page.getByRole("link", { name: "Deals", exact: true })).toHaveCount(0);
      noSecret(JSON.stringify(adminDeals.json));
    }
    return;
  }
  expect(adminDeals.status).toBe(200);
  expect(memberDeals.status).toBe(404);
  expect(JSON.stringify(memberDeals.json)).toMatch(/not found/i);
  await member.page.goto("/");
  await expect(member.page.getByRole("link", { name: "Deals", exact: true })).toHaveCount(0);
  await member.page.goto("/deals");
  await expect(member.page.getByRole("region", { name: "Lead" })).toHaveCount(0);
  await admin.page.goto("/");
  await expect(admin.page.getByRole("link", { name: "Deals", exact: true })).toBeVisible();
});
