// SHO-3040: deal capture accepts a typed buyer, reuses exact Account matches, and creates a new linked
// Account only after explicit confirmation. Existing deal/account permissions remain covered by APL-2539/2540.
import { expect, test, zz } from "../support";

async function fillDeal(page: import("@playwright/test").Page, buyer: string, deal: string) {
  await page.goto("/deals/new");
  await page.getByLabel("Deal name").fill(deal);
  await page.getByLabel("Client / Buyer").fill(buyer);
  await page.getByLabel("Why are we pursuing this?").fill("SHO-3040 acceptance");
  await page.getByLabel("First next step").fill(zz("buyer follow-up"));
}

test("SHO-3040 > typed buyer is retained and explicitly creates one linked Account", async ({ admin, later }) => {
  const buyer = zz("typed buyer");
  const deal = zz("typed buyer deal");
  await fillDeal(admin.page, buyer, deal);

  await admin.page.getByRole("button", { name: "Create deal", exact: true }).click();
  await expect(admin.page.locator(".err[role=alert]")).toContainText(`No existing organisation exactly matches "${buyer}"`);
  await expect(admin.page.getByLabel("Deal name")).toHaveValue(deal);
  await expect(admin.page.getByLabel("Client / Buyer")).toHaveValue(buyer);

  await admin.page.getByRole("button", { name: "Create buyer and deal", exact: true }).click();
  await expect(admin.page).toHaveURL(/\/projects\/[^/]+$/);
  const projectId = admin.page.url().split("/").pop()!;
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));

  const found = (await admin.api.get(`/api/orgs?q=${encodeURIComponent(buyer)}`)).json.organisations as { id: string; name: string }[];
  const account = found.find((o) => o.name === buyer);
  expect(account).toBeTruthy();
  later(() => admin.api.post(`/api/orgs/${account!.id}/archive`, { archive: true }));
  const project = (await admin.api.get(`/api/projects/${projectId}`)).json.project;
  expect(project.deal.parties).toEqual(expect.arrayContaining([expect.objectContaining({ role: "BUYER", organisation: expect.objectContaining({ id: account!.id, name: buyer }) })]));
});

test("SHO-3040 > an exact Account suggestion is reused without duplicate confirmation", async ({ admin, later }) => {
  const buyer = zz("existing buyer");
  const created = await admin.api.post("/api/orgs", { name: buyer });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const accountId = created.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${accountId}/archive`, { archive: true }));

  await fillDeal(admin.page, buyer, zz("existing buyer deal"));
  await admin.page.getByRole("button", { name: "Create deal", exact: true }).click();
  await expect(admin.page).toHaveURL(/\/projects\/[^/]+$/);
  const projectId = admin.page.url().split("/").pop()!;
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));

  const project = (await admin.api.get(`/api/projects/${projectId}`)).json.project;
  expect(project.deal.parties).toEqual(expect.arrayContaining([expect.objectContaining({ role: "BUYER", organisation: expect.objectContaining({ id: accountId }) })]));
  const matches = (await admin.api.get(`/api/orgs?q=${encodeURIComponent(buyer)}`)).json.organisations as { name: string }[];
  expect(matches.filter((o) => o.name === buyer)).toHaveLength(1);
  await expect(admin.page.getByRole("button", { name: "Create buyer and deal", exact: true })).toHaveCount(0);
});
