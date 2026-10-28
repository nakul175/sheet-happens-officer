// SHO-3029 / PR156 S3: exercise the real transaction, not a mocked releasePerson.
// CRM_VISIBLE changes only in this test worker; the serving application's flag is untouched.
import { afterAll, expect, it } from "vitest";
import { db } from "@/lib/db";
import { deactivate } from "@/lib/team";
import { account, superAdmin, task, type Account } from "./helpers";
import { cleanupHiddenProject, hiddenProjectFixture, withCrmMode, type HiddenDealFixture } from "./hidden-project";

const run = `${Date.now()}-${process.pid}`;
const fixtures: HiddenDealFixture[] = [];
const people: Account[] = [];
afterAll(async () => cleanupHiddenProject(fixtures, people));

it.each(["leaders", "viewer"] as const)("SHO-3029: real hidden-deal tasks move but do not inflate the reported count (%s)", async (mode) => {
  const sa = await superAdmin();
  const leaver = await account(`ZZ-TEST 3029 ${mode} leaver`, `nakul17+zz-3029-${run}-${mode}@aplyd.com`);
  const viewer = await account(`ZZ-TEST 3029 ${mode} viewer`, `nakul17+zz-3029-${run}-${mode}-viewer@aplyd.com`);
  people.push(leaver, viewer);
  const fixture = await hiddenProjectFixture(sa, {
    leader: sa, label: `3029 ${run} ${mode}`,
    members: [leaver, { who: viewer, role: "VIEWER" }],
  });
  fixtures.push(fixture);
  const visible = await task(sa, fixture.plain.id, { title: "ZZ-TEST visible handover", assigneeId: leaver.id });
  const hidden = await Promise.all([1, 2, 3].map((n) => task(sa, fixture.deal.id, {
    title: `ZZ-TEST hidden handover ${n}`, assigneeId: leaver.id,
  })));
  const actor = await db.user.findUniqueOrThrow({ where: { id: sa.id } });
  const result = await withCrmMode("off", () => deactivate(actor, leaver.id, mode === "leaders" ? "leaders" : viewer.id));
  expect(result).toEqual({ moved: 1, fellBack: mode === "leaders" ? [] : [fixture.plain.name] });
  expect(JSON.stringify(result)).not.toContain(fixture.deal.name);
  expect(JSON.stringify(result)).not.toContain(fixture.deal.id);
  // All four tasks must really move, including all three excluded from the response count.
  const tasks = await db.task.findMany({ where: { id: { in: [visible, ...hidden] } }, select: { id: true, assigneeId: true } });
  expect(tasks).toHaveLength(4);
  expect(tasks.every((t) => t.assigneeId === sa.id)).toBe(true);
  expect((await db.user.findUniqueOrThrow({ where: { id: leaver.id } })).deactivatedAt).not.toBeNull();
});
