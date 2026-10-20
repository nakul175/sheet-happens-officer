// tests/activity-delete-undo.test.ts backdates actionLog.createdAt through Prisma (there is no API to age an action row).
// It imports this file first, so a DATABASE_URL that is not a sho_test* database on this machine is refused before
// src/lib/db.ts or the test builds a PrismaClient (Pam D8, D10). CI uses localhost/sho_test.
let host = "";
let name = "";
try {
  const url = new URL(process.env.DATABASE_URL ?? "");
  host = url.hostname.toLowerCase();
  name = url.pathname.replace(/^\//, "");
} catch { host = ""; name = ""; }
if (host !== "localhost" && host !== "127.0.0.1") {
  throw new Error("Refusing tests/activity-delete-undo.test.ts: DATABASE_URL must be a database on this machine (it backdates rows).");
}
if (!name.startsWith("sho_test")) {
  throw new Error("Refusing tests/activity-delete-undo.test.ts: the database name must start with sho_test (it backdates rows).");
}

export {};
