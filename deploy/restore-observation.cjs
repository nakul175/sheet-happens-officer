// Take one internally consistent, read-only observation of each database.
// Matching counts remain presence evidence only, never a backup PASS.
async function observeRestoreCounts(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const tables = await client.query("select tablename from pg_tables where schemaname='public' order by 1");
    const out = {};
    for (const { tablename } of tables.rows) {
      const quoted = `"${tablename.replaceAll('"', '""')}"`;
      out[tablename] = Number((await client.query(`select count(*) n from ${quoted}`)).rows[0].n);
    }
    const newestUser = (await client.query('select max("createdAt") m from "User"')).rows[0].m;
    await client.query('COMMIT');
    return { out, newestUser };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = { observeRestoreCounts };
