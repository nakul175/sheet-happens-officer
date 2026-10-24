// SHO-2483 AC5: every receiver and affected Leader is told, including the acting Admin.
import { expect, it } from "vitest";
import { account, project, superAdmin, task } from "./helpers";
import { deactivate } from "../src/lib/team";
import { db } from "../src/lib/db";

it("deactivation tells the acting Leader once when they receive the leaver's task", async () => {
  const sa = await superAdmin();
  const leaver = await account("notice-leaver");
  const p = await project(sa, sa, [{ who: leaver }]);
  await task(sa, p.id, { assigneeId: leaver.id });
  const actor = await db.user.findUniqueOrThrow({ where: { id: sa.id } });
  await deactivate(actor, leaver.id, "leaders");
  const notices = await db.notification.findMany({ where: { recipientId: sa.id, projectId: p.id, type: "TASKS_HANDED_OVER" } });
  expect(notices).toHaveLength(1);
  expect(notices[0].data).toMatchObject({ moved: 1, toYou: true });
});

it("deactivation tells an acting receiver and a different Leader once each", async () => {
  const sa = await superAdmin();
  const lead = await account("notice-leader");
  const leaver = await account("notice-leaver-other");
  const p = await project(sa, lead, [{ who: leaver }]);
  await task(sa, p.id, { assigneeId: leaver.id });
  const actor = await db.user.findUniqueOrThrow({ where: { id: sa.id } });
  await deactivate(actor, leaver.id, sa.id);
  const notices = await db.notification.findMany({ where: { projectId: p.id, type: "TASKS_HANDED_OVER" } });
  expect(notices.map(n => n.recipientId).sort()).toEqual([sa.id, lead.id].sort());
});
