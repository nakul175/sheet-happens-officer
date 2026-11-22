import { createHash } from 'node:crypto';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const fingerprint = (rows) => ({ count: rows.length, sha256: sha256(JSON.stringify([...rows].sort())) });

// This runner has no user-selected restore target. Both databases are generated,
// created and owned by the run, after checking the actual GitHub service identity.
export function guardRecoveryEnvironment(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true') throw new Error('CI_ONLY');
  const url = new URL(env.DATABASE_URL);
  if (url.protocol !== 'postgresql:' || url.hostname !== 'localhost' || url.port !== '5432'
      || url.pathname !== '/sho_test' || url.username !== 'sho' || url.password !== 'sho'
      || url.search !== '?schema=public' || url.hash
      || env.DIRECT_DATABASE_URL !== env.DATABASE_URL) throw new Error('DATABASE_CONTAINMENT');
  if (!/^[a-f0-9]{64}$/.test(env.RECOVERY_POSTGRES_CONTAINER ?? '')) throw new Error('SERVICE_ID');
  return url;
}

export function ownedDatabaseName(kind, nonce) {
  if (!['source', 'target'].includes(kind) || !/^[a-f0-9]{24}$/.test(nonce)) throw new Error('DATABASE_NAME');
  return `sho_recovery_${kind}_${nonce}`;
}

export function compareManifest(expected, actual) {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
    .filter((key) => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]));
}

// Hash the server's canonical JSONB text, not JS-decoded numeric values. Decimal
// precision and row identity are preserved. Order is independent of query plans.
export async function databaseManifest(client) {
  const manifest = {};
  const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  for (const { tablename } of tables.rows) {
    const quoted = '"' + tablename.replaceAll('"', '""') + '"';
    const rows = await client.query(`SELECT to_jsonb(t)::text AS value FROM public.${quoted} t`);
    manifest[`table:${tablename}`] = fingerprint(rows.rows.map((row) => row.value));
  }
  const catalogues = {
    columns: `SELECT table_name,column_name,ordinal_position,column_default,is_nullable,data_type,udt_name,character_maximum_length,numeric_precision,numeric_scale,datetime_precision,collation_name,is_identity,identity_generation,is_generated,generation_expression FROM information_schema.columns WHERE table_schema='public'`,
    indexes: `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public'`,
    constraints: `SELECT c.relname,co.conname,pg_get_constraintdef(co.oid) AS definition,co.convalidated FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`,
    triggers: `SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal`,
    functions: `SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')`,
    enums: `SELECT t.typname,e.enumlabel,e.enumsortorder FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'`,
    sequences: `SELECT sequencename,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value FROM pg_sequences WHERE schemaname='public'`,
  };
  for (const [name, query] of Object.entries(catalogues)) {
    const rows = await client.query(`SELECT to_jsonb(v)::text AS value FROM (${query}) v`);
    manifest[`schema:${name}`] = fingerprint(rows.rows.map((row) => row.value));
  }
  return manifest;
}
