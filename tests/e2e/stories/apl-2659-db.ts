// Local-only helper for APL-2659. Ages a deal and seeds a concierge card. Prints an id or "ok". Never prints a secret.
// Refuses to run unless DATABASE_URL is local, or its database name is a staging/slot test database.
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "../../../src/generated/prisma/client";

/**
 * Hosts that may be written without a named test database.
 * Anything else is refused unless the database name matches {@link SLOT_TEST_DB}.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Staging and preview-slot test database names.
 *
 * From this branch (qa/story-e2e):
 * - `.github/workflows/deploy.yml` sets `POSTGRES_DB: sho_test`.
 * - `.github/workflows/staging-e2e.yml` `TARGET_ALLOWLIST` is
 *   `staging.sheethappensofficer.com` and `pr1`–`pr8.staging.sheethappensofficer.com`.
 *   The same workflows name databases with a `sho_` prefix (`sho_test`, `sho_viewport`, `sho_eval`).
 *
 * So a remote URL is allowed only when the database name is `sho_test`, `sho_staging`,
 * `staging`, `pr1`–`pr8`, or `sho_pr1`–`sho_pr8`. The staging app database is shared
 * with production, so a remote host by itself is not enough.
 */
const SLOT_TEST_DB = /^(sho_test|sho_staging|staging|pr[1-8]|sho_pr[1-8])$/i;

/** Throws before any connection when DATABASE_URL is not local and not a staging/slot test database. */
export function assertDatabaseUrl(raw: string | undefined): void {
  let parsed: URL;
  try {
    parsed = new URL(raw ?? "");
  } catch {
    throw new Error("DATABASE_URL is missing or not a URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL is missing or not a URL.");
  }
  const host = parsed.hostname.replace(/\.$/, "").toLowerCase();
  if (LOCAL_HOSTS.has(host)) return;
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] ?? "");
  if (SLOT_TEST_DB.test(name)) return;
  throw new Error(`Refusing to run against database host ${host || "(none)"}.`);
}

async function main() {
  assertDatabaseUrl(process.env.DATABASE_URL);
  const db = new PrismaClient();
  try {
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
  } finally {
    await db.$disconnect();
  }
}

const entry = process.argv[1];
const invokedDirectly = !!entry && import.meta.url === pathToFileURL(entry).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "The helper failed.");
    process.exitCode = 1;
  });
}
