// APL-2728. A shared deal the viewer cannot see is one fixed sentence on the person page, with no deal name and no link.
// CRM_VISIBLE is a server setting, so each test runs only in its own mode and skips otherwise. The skip reason names APL-2728.
// Deal names start with ZZ-TEST. The signed-in people are the nakul17+ story accounts (SHO_ADMIN_* / SHO_MEMBER_* or a shard's ZZ_TEST account).
// Under off, the CRM routes refuse to create a deal. That case is seeded on a local database only. Any other host is refused and never contacted.
import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "../support";
import { newDeal } from "../helpers/jim-http";
import { crmModeLive } from "../helpers/jim-gate";

const SENTENCE = "A deal you can't view.";
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;

test.beforeAll(() => {
  const missing = ["SHO_ADMIN_EMAIL", "SHO_ADMIN_PASS", "SHO_MEMBER_EMAIL", "SHO_MEMBER_PASS"].filter((name) => !process.env[name]);
  test.skip(missing.length > 0, `APL-2728: set ${missing.join(", ")} (nakul17+ accounts) before this story.`);
});

/** localhost only. A DigitalOcean host, or any other host, is refused before a connection is opened. */
function localDatabaseUrl(): string | null {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  let host = "";
  try { host = new URL(raw).hostname.toLowerCase().replace(/\.$/, ""); } catch { return null; }
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("APL-2728: refusing to use a database that is not on this machine.");
  }
  const url = new URL(raw);
  url.search = "";
  return url.toString();
}

function quote(value: string) {
  if (!/^[A-Za-z0-9 _+-]+$/.test(value)) throw new Error("APL-2728: refusing an unexpected value in local SQL.");
  return `'${value.replaceAll("'", "''")}'`;
}

function psql(sql: string): string | null {
  const url = localDatabaseUrl();
  if (!url) return null;
  try {
    return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-c", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/** A deal row the off server can read. Deal creation through the API is hidden in that mode. */
function seedLocalDeal(leaderId: string, memberId: string, name: string): { id: string } | null {
  const workspaceId = psql(`SELECT "workspaceId" FROM "User" WHERE id = ${quote(leaderId)}`);
  if (!workspaceId) return null;
  const id = `zz2728${Date.now().toString(36)}${process.pid.toString(36)}`;
  const inserted = psql(`
    INSERT INTO "Project" (id, "workspaceId", name, "typeId", "createdAt", "updatedAt")
    VALUES (${quote(id)}, ${quote(workspaceId)}, ${quote(name)}, 'wst_deal', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO "ProjectMember" ("projectId", "userId", role) VALUES
      (${quote(id)}, ${quote(leaderId)}, 'LEADER'),
      (${quote(id)}, ${quote(memberId)}, 'EDITOR');
    SELECT ${quote(id)};
  `);
  return inserted === id ? { id } : null;
}

function removeLocalDeal(id: string) {
  psql(`DELETE FROM "Project" WHERE id = ${quote(id)}`);
}

async function showsOneSentence(page: Page, personId: string, personName: string, dealName: string, dealId: string) {
  for (const size of VIEWPORTS) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/team/${personId}`);
    await expect(page.getByRole("heading", { level: 1, name: personName })).toBeVisible();
    await expect(page.getByText(SENTENCE, { exact: true })).toHaveCount(1);
    await expect(page.getByRole("link", { name: SENTENCE })).toHaveCount(0);
    await expect(page.getByText(dealName, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: dealName })).toHaveCount(0);
    await expect(page.getByText(dealId, { exact: true })).toHaveCount(0);
  }
}

test.describe("APL-2728 person page", () => {
  test("admins: one fixed sentence and no deal name at 1280x800 and 390x844 qa:TC missing", async ({ admin, member, later }) => {
    const mode = await crmModeLive(admin, member);
    test.skip(mode !== "admins", `APL-2728: this server runs CRM_VISIBLE=${mode}, not admins.`);
    const deal = await newDeal(admin, later, "person page", [member]);
    await showsOneSentence(member.page, admin.user.id as string, admin.user.name as string, deal.name, deal.id);
  });

  test("off: one fixed sentence and no deal name at 1280x800 and 390x844 qa:TC missing", async ({ admin, member, later }) => {
    const mode = await crmModeLive(admin, member);
    test.skip(mode !== "off", `APL-2728: this server runs CRM_VISIBLE=${mode}, not off.`);
    const name = `ZZ-TEST person page deal ${Date.now().toString(36)}`;
    const deal = seedLocalDeal(admin.user.id as string, member.user.id as string, name);
    if (!deal) {
      test.skip(true, "APL-2728: CRM_VISIBLE=off hides deal creation, and no local database could seed the deal.");
      return;
    }
    later(() => Promise.resolve(removeLocalDeal(deal.id)));
    await showsOneSentence(member.page, admin.user.id as string, admin.user.name as string, name, deal.id);
  });
});
