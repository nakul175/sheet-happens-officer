// Only fresh synthetic actors in an explicitly opted-in disposable LOCAL schema may be aged.
import { execFileSync } from "node:child_process";
import { localPgClient, schemaFromDatabaseUrl } from "./local-db-pool";
import { RUN, BASE_URL, type Json } from "../support";

export function agingDatabase(env: Record<string, string | undefined> = process.env, appUrl = BASE_URL) {
  if (env.SHO_OWNED_LOCAL_AGING !== "true") throw Error("SHO_OWNED_LOCAL_AGING=true is required for owned aging fixtures");
  const hosts = ["127.0.0.1", "localhost", "::1"];
  if (!hosts.includes(new URL(appUrl).hostname.replace(/^\[|\]$/g, ""))) throw Error("Owned aging requires a loopback application");
  const raw = env.DATABASE_URL;
  if (!raw) throw Error("Owned aging requires DATABASE_URL");
  const u = new URL(raw);
  if ([...u.searchParams.keys()].some(k => ["host", "hostaddr", "dbname", "database", "port", "user", "options"].includes(k.toLowerCase()))) throw Error("Owned aging refuses database routing overrides");
  const schema = schemaFromDatabaseUrl(raw);
  if (!hosts.includes(u.hostname.replace(/^\[|\]$/g, "")) || u.pathname !== "/sho_test" || !schema || !/^sho_(owned_aging|full_story)_[a-zA-Z0-9_]+$/.test(schema)) throw Error("Owned aging requires an isolated sho_test schema on loopback");
  return raw;
}

export async function ownedAging(user: Json) {
  const raw = agingDatabase();
  const client = localPgClient(raw);
  await client.connect();
  const owner = await client.query('SELECT id,email,name FROM "User" WHERE id=$1', [user.id]);
  const row = owner.rows[0];
  if (!row || !row.email.startsWith("nakul17+zz-") || !row.email.endsWith(`-${RUN}@aplyd.com`) || !row.name.startsWith("ZZ-") || !row.name.includes(RUN)) { await client.end(); throw Error("Fresh synthetic run-owned actor required"); }
  const messages = async (ids: string[]) => (await client.query('SELECT id,content,"createdAt" FROM "ChatMessage" WHERE "userId"=$1 AND id=ANY($2::text[]) ORDER BY id', [user.id, ids])).rows as { id: string; content: string; createdAt: Date }[];
  return {
    close: () => client.end(), messages,
    async age(ids: string[], at: Date) {
      if (!ids.length || (await messages(ids)).length !== ids.length) throw Error("All aged messages must belong to this fresh actor");
      const r = await client.query('UPDATE "ChatMessage" SET "createdAt"=$3 WHERE "userId"=$1 AND id=ANY($2::text[]) RETURNING id', [user.id, ids, at.toISOString()]);
      if (r.rowCount !== ids.length) throw Error("Owned aging row count changed");
    },
    async assertOnlyOwnedExpiry(ids: string[], at: Date) {
      const r = await client.query('SELECT count(*)::int AS n FROM "ChatMessage" WHERE "createdAt"<$1 AND NOT ("userId"=$2 AND id=ANY($3::text[]))', [new Date(at.getTime()-89*86400000).toISOString(), user.id, ids]);
      if (r.rows[0].n !== 0) throw Error("Retention job would reach non-owned aged messages; refusing");
    },
    async expireUndo(cardId: string, resultId: string, at: Date) {
      const rows = await messages([cardId, resultId]);
      if (rows.length !== 2) throw Error("Owned card and result required");
      const result = rows.find(r => r.id === resultId)!;
      const stored = JSON.parse(result.content);
      if (stored.kind !== "result" || stored.result?.cardId !== cardId || stored.internal?.cardMessageId !== cardId || !stored.internal.logIds?.length) throw Error("Real confirmed result and action logs required");
      await client.query("BEGIN");
      try {
        const logs = await client.query('UPDATE "ActionLog" SET "createdAt"=$3 WHERE "actorId"=$1 AND id=ANY($2::text[]) AND channel=\'CONCIERGE\' RETURNING id', [user.id, stored.internal.logIds, at.toISOString()]);
        if (logs.rowCount !== stored.internal.logIds.length) throw Error("Action logs are not all owned by this actor");
        for (const row of rows) {
          const s = JSON.parse(row.content);
          s.internal = { ...s.internal, confirmedAt: at.toISOString() };
          await client.query('UPDATE "ChatMessage" SET "createdAt"=$3,content=$4 WHERE "userId"=$1 AND id=$2', [user.id,row.id,at.toISOString(),JSON.stringify(s)]);
        }
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK"); throw e; }
    },
    purgeAt(at: Date) {
      // Call the real production function with its existing explicit instant; no global clock or transport mock.
      const code = `import { purgeChat } from './src/lib/concierge/thread.ts'; import { db } from './src/lib/db.ts'; purgeChat(new Date(${JSON.stringify(at.toISOString())})).then(n=>console.log(JSON.stringify({count:n}))).finally(()=>db.$disconnect());`;
      const safe: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", DATABASE_URL: raw, DIRECT_DATABASE_URL: raw, MODEL_DATA_APPROVED: "false" };
      return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: process.cwd(), env: safe, encoding: "utf8" }).trim()).count as number;
    },
  };
}
