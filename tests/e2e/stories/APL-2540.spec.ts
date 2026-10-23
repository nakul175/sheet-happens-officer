// SHO-US-12.4 Parties and roles on a deal (Linear APL-2540).
// One test per acceptance criterion. Sign-in is login("ADMIN") / login("MEMBER") via the fixtures.
// Organisations and deals are ZZ-TEST and archived afterwards. Open-deal rows are matched by this deal's id.
import { test, expect, zz } from "../support";
import { type Who } from "../g2";
import { pipelines } from "../helpers/deal-board";
import { createDeal, createOrg, dealBody, dealPanel, orgPage, projectOf } from "../helpers/claude-a";

type Party = { id: string; role: string; organisation: { id: string; name: string } };

const partiesOf = async (who: Who, id: string) => (await projectOf(who, id)).deal.parties as Party[];

test("APL-2540 > AC1: a deal has one Buyer, set at creation, and other roles can repeat except the same organisation and role", async ({ admin, later }) => {
  const pipes = await pipelines(admin.api);
  const buyer = await createOrg(admin, later, "only buyer");
  const funder = await createOrg(admin, later, "funder one");
  const funderTwo = await createOrg(admin, later, "funder two");
  const deal = await createDeal(admin, later, dealBody({ name: zz("party deal"), organisationId: buyer.id, pipelineId: pipes.pro.id, leaderId: admin.user.id }));

  const first = await partiesOf(admin, deal.id);
  expect(first.filter((p) => p.role === "BUYER")).toEqual([expect.objectContaining({ organisation: expect.objectContaining({ id: buyer.id }) })]);
  const again = await admin.api.post(`/api/projects/${deal.id}/parties`, { organisationId: funder.id, role: "BUYER" });
  expect(again.status, JSON.stringify(again.json)).toBe(400);
  expect(again.json.error).toBe("A deal has one Buyer, set when the deal is created.");
  const drop = await admin.api.del(`/api/projects/${deal.id}/parties/${first[0].id}`);
  expect(drop.status, JSON.stringify(drop.json)).toBe(400);
  expect(drop.json.error).toBe("The Buyer cannot be removed. Every deal has one.");

  const added = await admin.api.post(`/api/projects/${deal.id}/parties`, { organisationId: funder.id, role: "FUNDER" });
  expect(added.status, JSON.stringify(added.json)).toBe(201);
  const same = await admin.api.post(`/api/projects/${deal.id}/parties`, { organisationId: funder.id, role: "FUNDER" });
  expect(same.status, JSON.stringify(same.json)).toBe(409);
  expect(same.json.error).toBe("That organisation already has this role on the deal.");
  const otherRole = await admin.api.post(`/api/projects/${deal.id}/parties`, { organisationId: funder.id, role: "PARTNER" });
  expect(otherRole.status, JSON.stringify(otherRole.json)).toBe(201);
  const second = await admin.api.post(`/api/projects/${deal.id}/parties`, { organisationId: funderTwo.id, role: "FUNDER" });
  expect(second.status, JSON.stringify(second.json)).toBe(201);
  const now = await partiesOf(admin, deal.id);
  expect(now.filter((p) => p.role === "BUYER")).toHaveLength(1);
  expect(now.filter((p) => p.role === "FUNDER")).toHaveLength(2);

  await admin.page.goto(`/projects/${deal.id}`);
  // SHO-2996: the panel is the "Deal" landmark, so this AC and APL-2539 name the same box instead of <main> and its task list.
  const panel = dealPanel(admin.page);
  await expect(panel.getByRole("button", { name: `Remove ${buyer.name}` })).toHaveCount(0);
  await panel.getByRole("button", { name: "+ Add organisation" }).click();
  await expect(panel.getByLabel("Role").locator("option")).toHaveText(["Funder", "Implementing office", "Partner", "Other"]);
  // The same organisation is Funder and Partner, so "Remove <org>" is on two chips. Each chip is the parties line's
  // span that starts with its role ("Funder: ...") and links to that organisation, so the role plus the exact link
  // name names one chip even when a second organisation holds a similar name (SHO-2997/SHO-2922).
  const chipOf = (role: string, organisation: string) =>
    panel
      .locator("span.chip")
      .filter({ hasText: new RegExp(`^${role}:`) })
      .filter({ has: admin.page.getByRole("link", { name: organisation, exact: true }) });
  // SHO-2922: the ambiguity is real, not theoretical — an unscoped Remove <org> names the Funder chip AND the Partner
  // chip, because both hold the same organisation. The AC is that each chip's Remove is still reachable on its own.
  await expect(panel.getByRole("button", { name: `Remove ${funder.name}`, exact: true })).toHaveCount(2);
  await expect(chipOf("Funder", funder.name)).toHaveCount(1);
  await expect(chipOf("Partner", funder.name)).toHaveCount(1);
  const removeFunder = chipOf("Funder", funder.name).getByRole("button", { name: `Remove ${funder.name}`, exact: true });
  const removePartner = chipOf("Partner", funder.name).getByRole("button", { name: `Remove ${funder.name}`, exact: true });
  await expect(removeFunder).toBeVisible();
  await expect(removePartner).toBeVisible();
  await removeFunder.click();
  await expect(removeFunder).toHaveCount(0);
  await expect(removePartner).toBeVisible();
  const roles = (all: Party[], id: string) => all.filter((p) => p.organisation.id === id).map((p) => p.role).sort();
  const after = await partiesOf(admin, deal.id);
  expect(roles(after, funder.id), "only the Funder role is removed; the Partner role stays").toEqual(["PARTNER"]);
  expect(roles(after, funderTwo.id)).toEqual(["FUNDER"]);
  expect(after.some((p) => p.role === "BUYER" && p.organisation.id === buyer.id)).toBe(true);
});

test("APL-2540 > AC2: an organisation's open deals include every role the viewer is allowed to see", async ({ admin, member, later }) => {
  const pipes = await pipelines(admin.api);
  const buyer = await createOrg(admin, later, "role buyer");
  const funder = await createOrg(admin, later, "role funder");
  const name = zz("role deal");
  const deal = await createDeal(admin, later, dealBody({ name, organisationId: buyer.id, pipelineId: pipes.pro.id, leaderId: admin.user.id }));
  expect((await admin.api.post(`/api/projects/${deal.id}/parties`, { organisationId: funder.id, role: "FUNDER" })).status).toBe(201);

  const hidden = (await orgPage(member.api, funder.id)).deals as { projectId: string }[];
  expect(hidden.some((d) => d.projectId === deal.id)).toBe(false);
  const seen = (await orgPage(admin.api, funder.id)).deals as { projectId: string; role: string }[];
  expect(seen.find((d) => d.projectId === deal.id)?.role).toBe("FUNDER");
  expect((await orgPage(admin.api, buyer.id)).deals.find((d: { projectId: string; role: string }) => d.projectId === deal.id)?.role).toBe("BUYER");

  await admin.page.goto(`/accounts/${funder.id}`);
  const funderRow = admin.page.locator("tr", { hasText: name });
  await expect(funderRow).toContainText("FUNDER");
  await expect(funderRow).not.toContainText("BUYER");
  await admin.page.goto(`/accounts/${buyer.id}`);
  await expect(admin.page.locator("tr", { hasText: name })).toContainText("BUYER");

  expect((await admin.api.post(`/api/projects/${deal.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  const shown = (await orgPage(member.api, funder.id)).deals as { projectId: string; role: string }[];
  expect(shown.find((d) => d.projectId === deal.id)?.role).toBe("FUNDER");
});

test("APL-2540 > AC3: Introduced by is plain text and does not create or link an organisation", async ({ admin, later }) => {
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "intro buyer");
  const deal = await createDeal(admin, later, dealBody({ name: zz("intro deal"), organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id }));
  const who = zz("introducer");
  const saved = await admin.api.patch(`/api/projects/${deal.id}/deal`, { introducedBy: who });
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  expect((await projectOf(admin, deal.id)).deal.details.introducedBy).toBe(who);
  const found = (await admin.api.get(`/api/orgs?q=${encodeURIComponent(who)}`)).json.organisations as { name: string }[];
  expect(found.some((row) => row.name === who)).toBe(false);

  await admin.page.goto(`/projects/${deal.id}`);
  const panel = dealPanel(admin.page);
  await expect(panel.getByRole("link", { name: who })).toHaveCount(0);
  await panel.getByRole("button", { name: "Edit details" }).click();
  const dialog = admin.page.getByRole("dialog", { name: "Deal details" });
  await expect(dialog.getByLabel("Introduced by")).toHaveValue(who);
  await expect(dialog.getByRole("link", { name: who })).toHaveCount(0);
});

test("APL-2540 > AC4: an archived organisation stays on existing deals and cannot be added to a new one", async ({ admin, later }) => {
  const pipes = await pipelines(admin.api);
  const buyer = await createOrg(admin, later, "archived buyer");
  const deal = await createDeal(admin, later, dealBody({ name: zz("kept deal"), organisationId: buyer.id, pipelineId: pipes.pro.id, leaderId: admin.user.id }));
  expect((await admin.api.post(`/api/orgs/${buyer.id}/archive`, { archive: true })).status).toBe(200);
  const still = await partiesOf(admin, deal.id);
  expect(still.some((p) => p.role === "BUYER" && p.organisation.id === buyer.id)).toBe(true);
  await admin.page.goto(`/projects/${deal.id}`);
  // The archived buyer is linked twice in the deal panel (beside the pipeline and in the parties line). Scope to the parties line's "Buyer:" chip.
  const buyerParty = admin.page.getByRole("main").locator("span.chip").filter({ hasText: /^Buyer:/ });
  // SHO-2923: the archived buyer really is linked more than once inside main, so a bare link name is ambiguous; the
  // parties line's one "Buyer:" chip must still name exactly one link, and it is that buyer's.
  await expect.poll(() => admin.page.getByRole("main").getByRole("link", { name: buyer.name, exact: true }).count()).toBeGreaterThan(1);
  await expect(buyerParty).toHaveCount(1);
  await expect(buyerParty.getByRole("link", { name: buyer.name, exact: true })).toHaveCount(1);
  await expect(buyerParty.getByRole("link", { name: buyer.name, exact: true })).toHaveAttribute("href", `/accounts/${buyer.id}`);

  const fresh = dealBody({ name: zz("refused deal"), organisationId: buyer.id, pipelineId: pipes.pro.id, leaderId: admin.user.id });
  const refused = await admin.api.post("/api/deals", fresh);
  expect(refused.status, JSON.stringify(refused.json)).toBe(400);
  expect(refused.json.error).toBe("That organisation is archived.");
  const other = await createDeal(admin, later, dealBody({ name: zz("live deal"), organisationId: (await createOrg(admin, later, "live buyer")).id, pipelineId: pipes.pro.id, leaderId: admin.user.id }));
  const add = await admin.api.post(`/api/projects/${other.id}/parties`, { organisationId: buyer.id, role: "OTHER" });
  expect(add.status, JSON.stringify(add.json)).toBe(400);
  expect(add.json.error).toBe("That organisation is archived and cannot be added to a deal.");
});
