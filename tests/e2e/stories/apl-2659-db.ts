// Local-only helper for APL-2659. Ages a deal and seeds a concierge card. Prints an id or "ok". Never prints a secret.
import "dotenv/config";
import { PrismaClient } from "../../../src/generated/prisma/client";

async function main() {
  const db = new PrismaClient();
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "age") {
    const id = args[0];
    if (!id) throw new Error("age needs a project id");
    const t = new Date(Date.now() - 31 * 86400_000);
    await db.$executeRaw`UPDATE "Project" SET "createdAt" = ${t}, "stageChangedAt" = ${t} WHERE id = ${id}`;
    await db.$executeRaw`UPDATE "Task" SET "updatedAt" = ${t}, "createdAt" = ${t} WHERE "projectId" = ${id}`;
    await db.$executeRaw`UPDATE "ActionLog" SET "createdAt" = ${t} WHERE "projectId" = ${id}`;
    console.log("ok");
  } else if (cmd === "card") {
    const [userId, taskId] = args;
    if (!userId || !taskId) throw new Error("card needs a user id and a task id");
    const row = await db.chatMessage.create({
      data: {
        userId,
        role: "ASSISTANT",
        content: JSON.stringify({
          kind: "card",
          text: "Review this change.",
          card: { id: "", status: "PENDING", title: "Review this change", changes: [], canConfirm: true },
          proposal: { ops: [{ k: "task.edit", taskId, title: "ZZ-TEST retitle" }], fingerprint: "stale-on-purpose" },
        }),
      },
    });
    console.log(row.id);
  } else {
    throw new Error("unknown command");
  }
  await db.$disconnect();
}

main();
