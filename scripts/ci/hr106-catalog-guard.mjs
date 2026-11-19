// Catalog contract for the manual HR-106 design. The clean replay guard becomes
// mandatory only when the reviewed migration is actually packaged.
export const HR106_CONSTRAINTS = [
  'hr106_pipeline_id_type_key',
  'hr106_stage_id_pipeline_key',
  'hr106_project_pipeline_type_fkey',
  'hr106_project_stage_pipeline_fkey',
];

const expected = new Map([
  ['hr106_pipeline_id_type_key', { type: 'u', childTable: 'Pipeline', child: ['id', 'typeId'] }],
  ['hr106_stage_id_pipeline_key', { type: 'u', childTable: 'Stage', child: ['id', 'pipelineId'] }],
  ['hr106_project_pipeline_type_fkey', {
    type: 'f', childTable: 'Project', parentTable: 'Pipeline',
    child: ['pipelineId', 'typeId'], parent: ['id', 'typeId'], setNull: ['pipelineId'],
  }],
  ['hr106_project_stage_pipeline_fkey', {
    type: 'f', childTable: 'Project', parentTable: 'Stage',
    child: ['stageId', 'pipelineId'], parent: ['id', 'pipelineId'], setNull: ['stageId'],
  }],
]);

export function checkHr106Rows(rows, { required = false } = {}) {
  if (!required && rows.length === 0) return 'NOT_INSTALLED';
  if (rows.length !== expected.size) throw new Error('HR106_CATALOG_CONSTRAINT_COUNT');
  const names = new Set();
  for (const constraint of rows) {
    const want = expected.get(constraint.conname);
    if (!want || names.has(constraint.conname) || constraint.contype !== want.type || !constraint.convalidated ||
        constraint.child_table !== want.childTable ||
        (want.parentTable && constraint.parent_table !== want.parentTable) ||
        JSON.stringify(constraint.child_cols) !== JSON.stringify(want.child) ||
        (want.parent && JSON.stringify(constraint.parent_cols) !== JSON.stringify(want.parent)) ||
        (want.setNull && (constraint.confdeltype !== 'n' ||
          JSON.stringify(constraint.set_null_cols) !== JSON.stringify(want.setNull)))) {
      throw new Error(`HR106_CATALOG_DRIFT:${constraint.conname}`);
    }
    names.add(constraint.conname);
  }
  return 'VALIDATED';
}

export async function checkHr106Catalog(client, options) {
  const { rows } = await client.query(`
    SELECT c.conname, c.contype, c.convalidated, c.confdeltype,
      child.relname AS child_table, parent.relname AS parent_table,
      (SELECT array_agg(a.attname::text ORDER BY u.ord)
         FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) AS child_cols,
      (SELECT array_agg(a.attname::text ORDER BY u.ord)
         FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum) AS parent_cols,
      (SELECT array_agg(a.attname::text ORDER BY u.ord)
         FROM unnest(c.confdelsetcols) WITH ORDINALITY AS u(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) AS set_null_cols
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    LEFT JOIN pg_class parent ON parent.oid = c.confrelid
    WHERE c.connamespace = 'public'::regnamespace
      AND c.conname = ANY($1::text[])
  `, [HR106_CONSTRAINTS]);
  return { status: checkHr106Rows(rows, options), count: rows.length };
}
