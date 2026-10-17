// Compares row counts of production and a restored copy (story 9.3, AC3). Run on the droplet by
// .github/workflows/restore-check.yml. The restored database's URL is read from a private temp file, never an
// argument, and nothing here prints a connection string.
const { Client } = require("pg");
const fs = require("node:fs");

function clean(u) { const x = new URL(u); x.searchParams.delete("sslmode"); return x.toString(); }
async function counts(url) {
  const c = new Client({ connectionString: clean(url), ssl: { rejectUnauthorized: false } });
  await c.connect();
  const t = await c.query("select tablename from pg_tables where schemaname='public' order by 1");
  const out = {};
  for (const { tablename } of t.rows) out[tablename] = Number((await c.query(`select count(*) n from "${tablename}"`)).rows[0].n);
  const u = await c.query(`select max("createdAt") m from "User"`).catch(() => ({ rows: [{}] }));
  await c.end();
  return { out, newestUser: u.rows[0].m };
}
(async () => {
  const env = Object.fromEntries(fs.readFileSync("/etc/sho/app.env", "utf8").split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^'|'$/g, "")];
  }));
  const restoreUrl = fs.readFileSync("/tmp/rc.url", "utf8").trim();
  if (!restoreUrl || !env.DATABASE_URL) throw new Error("missing a connection string");
  const [prod, rest] = [await counts(env.DATABASE_URL), await counts(restoreUrl)];
  let bad = 0;
  const names = [...new Set([...Object.keys(prod.out), ...Object.keys(rest.out)])].sort();
  console.log("table".padEnd(22), "production".padStart(11), "restored".padStart(10));
  for (const n of names) {
    const p = prod.out[n], r = rest.out[n];
    const note = r === undefined ? "  MISSING in restore" : r > p ? "  MORE than production" : "";
    if (note) bad++;
    console.log(n.padEnd(22), String(p ?? "-").padStart(11), String(r ?? "-").padStart(10), note);
  }
  console.log("newest user  production:", prod.newestUser?.toISOString?.() ?? "none", " restored:", rest.newestUser?.toISOString?.() ?? "none");
  const users = rest.out.User ?? 0;
  console.log(bad === 0 && users > 0 ? "PASS  restored copy has every table and real data" : "FAIL  restored copy is incomplete");
  process.exit(bad === 0 && users > 0 ? 0 : 1);
})().catch((e) => { console.error("FAIL ", e.message); process.exit(1); });
