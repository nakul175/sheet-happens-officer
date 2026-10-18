// APL-2686: undo of Organisation archived / unarchived reverses the action (APL-2532 AC6).
// Calls src/lib directly against Postgres. No dev server.
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { undoAction } from "../src/lib/undo";
import type { Actor } from "../src/lib/access";

const db = new PrismaClient();

let n = 0;

async function seed(archived: boolean) {
  n += 1;
  const stamp = `${Date.now()}-${n}`;
  const ws = await db.workspace.create({ data: { name: `org-undo-${stamp}` } });
  const user = await db.user.create({
    data: {
      workspaceId: ws.id,
      email: `org-undo-${stamp}@aplyd.com`,
      name: "Undo",
      passwordHash: "not-used",
      orgRole: "MEMBER",
    },
  });
  const org = await db.organisation.create({
    data: {
      workspaceId: ws.id,
      name: `Acme ${stamp}`,
      createdById: user.id,
      archivedAt: archived ? new Date("2026-01-01T00:00:00Z") : null,
    },
  });
  const actor: Actor = { id: user.id, orgRole: "MEMBER", name: user.name };
  return { org, actor };
}

function log(
  actorId: string,
  orgId: string,
  action: "organisation.archived" | "organisation.unarchived",
  beforeArchived: boolean,
  afterArchived: boolean,
) {
  const at = (archived: boolean) => (archived ? "2026-01-02T00:00:00.000Z" : null);
  return db.actionLog.create({
    data: {
      actorId,
      channel: "SCREEN",
      projectId: null,
      targetType: "organisation",
      targetId: orgId,
      action,
      beforeState: { archivedAt: at(beforeArchived) },
      afterState: { archivedAt: at(afterArchived) },
    },
  });
}

describe("undo of organisation archived / unarchived (APL-2686)", () => {
  afterAll(async () => {
    await db.$disconnect();
  });

  it("undo of Organisation archived unarchives the organisation", async () => {
    const { org, actor } = await seed(true);
    const row = await log(actor.id, org.id, "organisation.archived", false, true);
    const result = await undoAction(actor, row.id);
    expect(result.label).toBe("Organisation archived");
    const now = await db.organisation.findUniqueOrThrow({ where: { id: org.id } });
    expect(now.archivedAt).toBeNull();
    expect((await db.actionLog.findUniqueOrThrow({ where: { id: row.id } })).undoneAt).toBeTruthy();
  });

  it("undo of Organisation unarchived archives the organisation", async () => {
    const { org, actor } = await seed(false);
    const row = await log(actor.id, org.id, "organisation.unarchived", true, false);
    const result = await undoAction(actor, row.id);
    expect(result.label).toBe("Organisation unarchived");
    const now = await db.organisation.findUniqueOrThrow({ where: { id: org.id } });
    expect(now.archivedAt).toBeInstanceOf(Date);
  });

  it("refuses when the organisation is already in the reversed state", async () => {
    const unarchived = await seed(false);
    const archivedLog = await log(unarchived.actor.id, unarchived.org.id, "organisation.archived", false, true);
    await expect(undoAction(unarchived.actor, archivedLog.id)).rejects.toMatchObject({
      status: 409,
      message: "This organisation is not archived any more.",
    });
    expect((await db.organisation.findUniqueOrThrow({ where: { id: unarchived.org.id } })).archivedAt).toBeNull();

    const archived = await seed(true);
    const unarchivedLog = await log(archived.actor.id, archived.org.id, "organisation.unarchived", true, false);
    await expect(undoAction(archived.actor, unarchivedLog.id)).rejects.toMatchObject({
      status: 409,
      message: "This organisation is already archived.",
    });
    expect((await db.organisation.findUniqueOrThrow({ where: { id: archived.org.id } })).archivedAt).not.toBeNull();
  });
});
