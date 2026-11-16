import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { holySheetDocumentId, holySheetOrigin, isApprovedHolySheetOrigin } from "@/lib/holy-sheet-url";
import { account, BASE, cleanupZz, project, task, type Account } from "./helpers";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

const approved = "https://holysheet.aplyd.org";
const pageId = "11111111-1111-4111-8111-111111111111";
let lead: Account, projectId: string, taskId: string;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  lead = await account("holy-off-boundary");
  const p = await project(lead, lead);
  projectId = p.id;
  taskId = await task(lead, projectId, { title: "ZZ-TEST Holy Sheet OFF boundary" });
});

afterAll(async () => {
  if (projectId && lead) await cleanupZz([projectId], [lead]);
});

describe("Holy Sheet OFF and URL boundary", () => {
  it("enables only exact approved origins under the explicit flag", () => {
    expect(holySheetOrigin({ FF_HOLY_SHEET: "0", HOLY_SHEET_ORIGIN: approved })).toBeNull();
    expect(holySheetOrigin({ FF_HOLY_SHEET: "1", HOLY_SHEET_ORIGIN: approved })).toBe(approved);
    expect(holySheetOrigin({ FF_HOLY_SHEET: "1", HOLY_SHEET_ORIGIN: "https://staging.holysheet.aplyd.org" })).toBe("https://staging.holysheet.aplyd.org");
    for (const origin of ["http://127.0.0.1", "https://holysheet.aplyd.org.evil.invalid", "https://holysheet.aplyd.org/", "https://evil.invalid"]) {
      expect(isApprovedHolySheetOrigin(origin), origin).toBe(false);
      expect(holySheetOrigin({ FF_HOLY_SHEET: "1", HOLY_SHEET_ORIGIN: origin })).toBeNull();
    }
  });

  it("accepts only a page UUID path at the approved origin", () => {
    expect(holySheetDocumentId(`${approved}/pages/${pageId}`, approved)).toBe(pageId);
    expect(holySheetDocumentId(`${approved}/pages/${pageId}/`, approved)).toBe(pageId);
    for (const value of [
      `https://holysheet.aplyd.org.evil.invalid/pages/${pageId}`,
      `http://127.0.0.1/pages/${pageId}`,
      `https://user:pass@holysheet.aplyd.org/pages/${pageId}`,
      `${approved}/pages/${pageId}?next=https://evil.invalid`,
      `${approved}/pages/${pageId}#secret`,
      `${approved}/pages/not-a-uuid`,
      `${approved}/pages/${pageId}/extra`,
      `javascript:${pageId}`,
    ]) expect(holySheetDocumentId(value, approved), value).toBeNull();
  });

  it("keeps direct project and task document routes unavailable without creating links", async () => {
    // The qualification server must be launched with the integration disabled.
    expect(process.env.FF_HOLY_SHEET).not.toBe("1");
    const paths = [`/api/projects/${projectId}/documents`, `/api/tasks/${taskId}/documents`, `/api/tasks/${taskId}/holy-sheet`];
    const before = await db.holySheetLink.count({ where: { projectId } });
    for (const path of paths) {
      expect((await lead.c.get(path)).status, path).toBe(404);
    }
    for (const path of paths.slice(0, 2)) {
      for (const method of ["POST", "DELETE"]) {
        const response = await fetch(BASE + path, {
          method,
          headers: { "content-type": "application/json", origin: "https://sheethappensofficer.aplyd.org", cookie: lead.c.cookie },
          body: JSON.stringify({ subject: "synthetic-subject", pageId }),
        });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(await db.holySheetLink.count({ where: { projectId } })).toBe(before);
  });
});
