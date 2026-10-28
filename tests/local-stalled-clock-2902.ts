// Test-only clock setup. No production route imports this module.
import { db } from "../src/lib/db";
const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);
export function assertStalledFixtureTarget(databaseUrl = process.env.DATABASE_URL, apiUrl = process.env.TASKBOARD_URL ?? "http://localhost:3000") {
  let database: URL, api: URL;
  try { database = new URL(databaseUrl ?? ""); api = new URL(apiUrl); } catch { throw new Error("Stalled fixtures require local test targets"); }
  const host = (url: URL) => url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOCAL.has(host(database)) || !LOCAL.has(host(api)) || !/^postgres(?:ql)?:$/.test(database.protocol) || !/^https?:$/.test(api.protocol) || database.pathname !== "/sho_test") {
    throw new Error("Stalled fixtures require localhost API and sho_test database");
  }
  // pg connection-string query keys can override authority fields (for example ?host=).
  // Accept only the Prisma test schema and bounded local pool settings; never a target override.
  const allowed = new Set(["schema", "connection_limit", "pool_timeout"]);
  for (const [key, value] of database.searchParams) {
    if (!allowed.has(key) || database.searchParams.getAll(key).length !== 1 ||
      (key === "schema" ? !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value) : !/^\d{1,3}$/.test(value))) {
      throw new Error("Stalled fixtures refuse database target overrides");
    }
  }
}
/** The only non-API fixture operation: age three validated, run-owned deals atomically. */
export async function ageLocalStalledDeals(ids: string[], tag: string) {
  assertStalledFixtureTarget();
  if (!/^[a-z0-9-]{6,80}$/i.test(tag) || ids.length !== 3 || new Set(ids).size !== 3 || ids.some(id => !id)) throw new Error("Invalid stalled fixture identity");
  const time = new Date(Date.now() - 31 * 86400_000);
  await db.$transaction(async tx => {
    const projects = await tx.project.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, archivedAt: true, tasks: { select: { title: true } } } });
    if (projects.length !== 3 || projects.some(p => !p.name.startsWith("ZZ-TEST ") || !p.name.endsWith(` ${tag}`) || p.archivedAt || p.tasks.some(t => !t.title.startsWith("ZZ-TEST ") || !t.title.endsWith(` ${tag}`)))) throw new Error("Refusing to age non-fixture data");
    await tx.project.updateMany({ where: { id: { in: ids } }, data: { createdAt: time, stageChangedAt: time } });
    await tx.task.updateMany({ where: { projectId: { in: ids } }, data: { updatedAt: time } });
    await tx.actionLog.updateMany({ where: { projectId: { in: ids } }, data: { createdAt: time } });
  });
}
