// Fingerprint the custom SQL objects after a clean disposable migration replay.
// Outputs names and digests only; no database rows or connection details.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';

const expected = {
  index: ['DealParty_one_buyer_per_deal', 'ProjectMember_one_leader_per_project', 'Project_live_vertical_name_idx', 'Section_one_done_per_project', 'TaskLink_unique_contact', 'TaskLink_unique_org'],
  check: ['DealDetails_netFeeRevenueUsd_nonnegative', 'DealDetails_probability_range', 'DealDetails_value_has_currency', 'Project_stage_needs_pipeline', 'TaskLink_exactly_one_target', 'User_email_lowercase'],
  function: ['enforce_max_sections', 'enforce_task_section_in_project', 'holy_sheet_task_move', 'sho_additional_workspace_only'],
  trigger: ['Section_max_8', 'Task_section_in_project', 'holy_sheet_task_move', 'sho_additional_workspace_only'],
};
const sql = {
  index: `SELECT indexname AS name, md5(indexdef) AS digest FROM pg_indexes
    WHERE schemaname='public' AND indexname=ANY($1::text[]) ORDER BY indexname`,
  check: `SELECT c.conname AS name, md5(pg_get_constraintdef(c.oid)) AS digest
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname='public' AND c.contype='c' AND c.conname=ANY($1::text[]) ORDER BY c.conname`,
  function: `SELECT p.proname AS name, md5(pg_get_functiondef(p.oid)) AS digest,
    coalesce(array_to_string(p.proconfig,','),'') AS config
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname`,
  trigger: `SELECT t.tgname AS name, md5(pg_get_triggerdef(t.oid)) AS digest
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgname=ANY($1::text[]) ORDER BY t.tgname`,
};

assert.ok(process.env.DIRECT_DATABASE_URL, 'Disposable CI database URL required');
const client = new pg.Client({ connectionString: process.env.DIRECT_DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 8000 });
try {
  await client.connect();
  for (const kind of Object.keys(expected)) {
    const { rows } = await client.query(sql[kind], [expected[kind]]);
    rows.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    assert.deepEqual(rows.map((r) => r.name), [...expected[kind]].sort());
    if (kind === 'function') {
      for (const name of ['enforce_max_sections', 'enforce_task_section_in_project', 'holy_sheet_task_move']) {
        assert.match(rows.find((r) => r.name === name)?.config ?? '', /(?:^|,)search_path=/);
      }
    }
    const fingerprint = createHash('md5').update(rows.map((r) => `${r.name}=${r.digest}`).join('|')).digest('hex');
    console.log(`SCHEMA_CATALOG_${kind.toUpperCase()} ${rows.length}/${expected[kind].length} ${fingerprint}`);
  }
} finally {
  await client.end().catch(() => {});
}
