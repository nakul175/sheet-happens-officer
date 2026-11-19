import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHr106Rows } from './hr106-catalog-guard.mjs';

const valid = [
  { conname: 'hr106_pipeline_id_type_key', contype: 'u', convalidated: true,
    child_table: 'Pipeline', child_cols: ['id', 'typeId'] },
  { conname: 'hr106_stage_id_pipeline_key', contype: 'u', convalidated: true,
    child_table: 'Stage', child_cols: ['id', 'pipelineId'] },
  { conname: 'hr106_project_pipeline_type_fkey', contype: 'f', convalidated: true,
    child_table: 'Project', parent_table: 'Pipeline',
    child_cols: ['pipelineId', 'typeId'], parent_cols: ['id', 'typeId'], confdeltype: 'n', set_null_cols: ['pipelineId'] },
  { conname: 'hr106_project_stage_pipeline_fkey', contype: 'f', convalidated: true,
    child_table: 'Project', parent_table: 'Stage',
    child_cols: ['stageId', 'pipelineId'], parent_cols: ['id', 'pipelineId'], confdeltype: 'n', set_null_cols: ['stageId'] },
];

test('an unapplied draft allows a clean catalog but rejects partial installation', () => {
  assert.equal(checkHr106Rows([]), 'NOT_INSTALLED');
  assert.throws(() => checkHr106Rows(valid.slice(0, 3)), /HR106_CATALOG_CONSTRAINT_COUNT/);
});

test('packaging makes all four exact validated constraints mandatory', () => {
  assert.throws(() => checkHr106Rows([], { required: true }), /HR106_CATALOG_CONSTRAINT_COUNT/);
  assert.equal(checkHr106Rows(valid, { required: true }), 'VALIDATED');
  assert.throws(() => checkHr106Rows([...valid.slice(0, 3), valid[0]], { required: true }), /HR106_CATALOG_DRIFT/);
});

test('rejects Prisma-style composite SET NULL and changed key order', () => {
  const wrongDelete = valid.map((row) => ({ ...row }));
  wrongDelete[2].set_null_cols = null;
  assert.throws(() => checkHr106Rows(wrongDelete, { required: true }), /HR106_CATALOG_DRIFT/);
  const wrongOrder = valid.map((row) => ({ ...row }));
  wrongOrder[3].child_cols = ['pipelineId', 'stageId'];
  assert.throws(() => checkHr106Rows(wrongOrder, { required: true }), /HR106_CATALOG_DRIFT/);
  const wrongTable = valid.map((row) => ({ ...row }));
  wrongTable[3].parent_table = 'Pipeline';
  assert.throws(() => checkHr106Rows(wrongTable, { required: true }), /HR106_CATALOG_DRIFT/);
});
