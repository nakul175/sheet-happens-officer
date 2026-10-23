// SHO-2918 / SHO-2919: the two APL-2536 story-spec defects, verified at this head.
// SHO-2918 (AC v1.0): AC1's tree-parent link is located by a role/name locator scoped to the tree, with no
//   strict-mode violation. SHO-2919 (AC v1.0): AC4's search term is a substring of the seeded organisation's exact
//   name, and the expected row is found. Both are spec defects, so the regression guard reads the spec that ships.
// The packet also names "locked comment-restore Undo answers 409": that is SHO-3019's behaviour (no comment lock
// exists in this schema), so the third block proves the 409 at the cap on this head and says so in the report.
// Database rows are ZZ-TEST data in a throwaway workspace and are deleted again. Nothing here needs a server.
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, expect as pw, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import type { Actor } from "../src/lib/access";
import { listOrganisations } from "../src/lib/orgs";
import { undoAction } from "../src/lib/undo";

const SPEC = path.join(process.cwd(), "tests/e2e/stories/APL-2536.spec.ts");
const CAP_MESSAGE = "A task can have at most 200 comments.";
const STAMP = `${Date.now().toString(36)}-${process.pid}`;

/** The body of one Playwright test, from its `test("<title>` to the next top-level `test(`. */
function testBody(title: string) {
  const source = readFileSync(SPEC, "utf8");
  const start = source.indexOf(`test("${title}`);
  if (start < 0) throw new Error(`${SPEC} has no test "${title}"`);
  const next = source.indexOf("\ntest(", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

describe("SHO-2918: APL-2536 AC1 locates the tree-parent link uniquely", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("ships the tree-scoped, exact locator and not the unscoped one", () => {
    const ac1 = testBody("APL-2536 > AC1:");
    // The pre-fix line was `getByRole("link", { name: parent.name })`, which matches the breadcrumb as well.
    expect(ac1, "AC1 still contains the unscoped parent link locator").not.toContain('getByRole("link", { name: parent.name })');
    // The fix: a list item that holds the parent link and the highlighted leaf, the link exact, and its href asserted.
    expect(ac1).toContain('getByRole("listitem")');
    expect(ac1).toContain('getByRole("link", { name: parent.name, exact: true })');
    expect(ac1).toContain(".filter({ hasText: leaf.name })");
    expect(ac1).toContain('toHaveAttribute("href", `/accounts/${parent.id}`)');
  });

  it("the old locator violates strict mode where the scoped one resolves one link", async () => {
    const page = await browser.newPage();
    // The organisation page as OrgView renders it: the parent is the breadcrumb link AND the tree's parent link.
    await page.setContent(`<!doctype html><html><body>
      <nav aria-label="Breadcrumb"><a href="/accounts/PARENT">Parent</a> <span>/</span> <span>Leaf</span></nav>
      <aside><div class="grp">Organisation tree</div><div class="card"><ul>
        <li><a href="/accounts/PARENT">Parent</a><ul><li><a href="/accounts/LEAF" aria-current="page">Leaf</a></li></ul></li>
      </ul></div></aside>
    </body></html>`);
    const unscoped = page.getByRole("link", { name: "Parent" });
    await pw(unscoped).toHaveCount(2);
    const violation = await pw(unscoped).toBeVisible({ timeout: 1000 }).then(() => null, (e: Error) => e);
    expect(violation, "the unscoped locator no longer violates strict mode").toBeInstanceOf(Error);
    expect(violation?.message).toContain("strict mode violation");
    expect(violation?.message).toContain("resolved to 2 elements");

    const tree = page.getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: "Parent", exact: true }) })
      .filter({ hasText: "Leaf" });
    await pw(tree).toHaveCount(1);
    await pw(tree.getByRole("link", { name: "Parent", exact: true })).toHaveAttribute("href", "/accounts/PARENT");
    await page.close();
  });
});

describe("SHO-2919: APL-2536 AC4 finds the seeded organisation", () => {
  const db = new PrismaClient();
  let ws: string;
  let actor: Actor;
  let active: { id: string; name: string };
  let other: { id: string; name: string };

  beforeAll(async () => {
    const workspace = await db.workspace.create({ data: { name: `SHO-2919 ${STAMP}` } });
    ws = workspace.id;
    const user = await db.user.create({
      data: { workspaceId: ws, email: `sho2919-${STAMP}@example.invalid`, name: "SHO-2919", passwordHash: "not-used", orgRole: "MEMBER" },
    });
    actor = { id: user.id, orgRole: "MEMBER", name: user.name };
    const make = async (name: string) => {
      const o = await db.organisation.create({ data: { workspaceId: ws, name, createdById: user.id } });
      return { id: o.id, name: o.name };
    };
    // The names AC4 seeds. The old term `zz("open")` is "ZZ-TEST open <RUN>" and has no " active" in it.
    active = await make(`ZZ-TEST open active ${STAMP}`);
    other = await make(`ZZ-TEST open other ${STAMP}`);
  });

  afterAll(async () => {
    await db.organisation.deleteMany({ where: { workspaceId: ws } });
    await db.user.deleteMany({ where: { workspaceId: ws } });
    await db.workspace.deleteMany({ where: { id: ws } });
    await db.$disconnect();
  });

  it("ships a query built from the organisation's own exact name", () => {
    const ac4 = testBody("APL-2536 > AC4:");
    // The pre-fix line was `/api/orgs?q=${encodeURIComponent(zz("open"))}`, which can never match.
    expect(ac4, "AC4 still queries the generic zz(\"open\") term").not.toContain('encodeURIComponent(zz("open"))');
    expect(ac4).toContain("encodeURIComponent(org.name)");
    expect(ac4).toContain("const count = async (org: { id: string; name: string })");
  });

  it("the old term finds nothing while the exact name finds the seeded row", async () => {
    const oldTerm = `ZZ-TEST open ${STAMP}`;
    expect(active.name.includes(oldTerm), "the old term is now a substring of the seeded name").toBe(false);
    const stale = await listOrganisations(actor, { q: oldTerm });
    expect(stale.map((o) => o.id), "the old query matched a seeded organisation").not.toContain(active.id);

    // What the fixed spec asks: q=<that organisation's own name>.
    const found = await listOrganisations(actor, { q: active.name });
    expect(found.map((o) => o.id), "the exact-name query did not find the row").toContain(active.id);
    expect(found.map((o) => o.id)).not.toContain(other.id);
  });
});

describe("SHO-3019 claim carried in the SHO-2919 packet: a comment restore at the cap answers 409", () => {
  const db = new PrismaClient();
  const previous = process.env.FF_TASK_COMMENTS;
  let ws: string;
  let projectId: string;
  let taskId: string;
  let removedId: string;
  let logId: string;
  let actor: Actor;

  beforeAll(async () => {
    process.env.FF_TASK_COMMENTS = "true"; // comment action rows are a 404 while the switch is off (APL-2590 D1)
    const workspace = await db.workspace.create({ data: { name: `SHO-3019 ${STAMP}` } });
    ws = workspace.id;
    const user = await db.user.create({
      data: { workspaceId: ws, email: `sho3019-${STAMP}@example.invalid`, name: "SHO-3019", passwordHash: "not-used", orgRole: "MEMBER" },
    });
    actor = { id: user.id, orgRole: "MEMBER", name: user.name };
    const project = await db.project.create({
      data: {
        workspaceId: ws,
        name: `SHO-3019 ${STAMP}`,
        members: { create: { userId: user.id, role: "LEADER" } },
        sections: { create: { name: "To do", position: 0 } },
      },
      include: { sections: true },
    });
    projectId = project.id;
    const task = await db.task.create({
      data: { workspaceId: ws, projectId, sectionId: project.sections[0].id, title: `SHO-3019 task ${STAMP}`, assigneeId: user.id, createdById: user.id },
    });
    taskId = task.id;
    const removed = await db.comment.create({ data: { taskId, authorId: user.id, text: "deleted comment", removedAt: new Date() } });
    removedId = removed.id;
    await db.comment.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({ taskId, authorId: user.id, text: `live comment ${i}` })),
    });
    const log = await db.actionLog.create({
      data: {
        actorId: user.id, channel: "SCREEN", projectId, targetType: "task", targetId: taskId, action: "comment.removed",
        beforeState: { commentId: removedId }, afterState: { commentId: removedId },
      },
    });
    logId = log.id;
  });

  afterAll(async () => {
    await db.actionLog.deleteMany({ where: { projectId } });
    await db.comment.deleteMany({ where: { taskId } });
    await db.task.deleteMany({ where: { projectId } });
    await db.project.deleteMany({ where: { id: projectId } });
    await db.user.deleteMany({ where: { workspaceId: ws } });
    await db.workspace.deleteMany({ where: { id: ws } });
    await db.$disconnect();
    if (previous === undefined) delete process.env.FF_TASK_COMMENTS;
    else process.env.FF_TASK_COMMENTS = previous;
  });

  it("refuses the restore with 409 too_many_comments and writes nothing", async () => {
    const err = await undoAction(actor, logId).then(() => null, (e: unknown) => e as { status?: number; message?: string; extra?: { code?: string } });
    expect(err, "Undo restored a comment past the 200-comment cap").not.toBeNull();
    expect(err?.status, err?.message).toBe(409);
    expect(err?.message).toBe(CAP_MESSAGE);
    expect(err?.extra?.code).toBe("too_many_comments");

    const stillRemoved = await db.comment.findUniqueOrThrow({ where: { id: removedId }, select: { removedAt: true } });
    expect(stillRemoved.removedAt, "the comment was restored despite the 409").not.toBeNull();
    expect(await db.actionLog.count({ where: { projectId, action: "undo" } }), "Undo logged a write after refusing").toBe(0);
    expect(await db.comment.count({ where: { taskId, removedAt: null } })).toBe(200);
  });
});

