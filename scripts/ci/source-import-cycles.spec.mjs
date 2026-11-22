import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findImportCycles, sourceImportGraph } from './source-import-cycles.mjs';

test('cycle detector distinguishes a DAG from a real import cycle and a self-import', () => {
  assert.deepEqual(findImportCycles(new Map([['a', ['b']], ['b', ['c']], ['c', []]])), []);
  assert.deepEqual(findImportCycles(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]])), [['a', 'b', 'c']]);
  assert.deepEqual(findImportCycles(new Map([['a', ['a']]])), [['a']]);
});

test('current hand-maintained source graph has no static import cycle', () => {
  const graph = sourceImportGraph();
  assert.ok(graph.size > 100);
  assert.ok([...graph.keys()].every((file) => !file.includes('/src/generated/')));
  assert.deepEqual(findImportCycles(graph), []);
});

test('TypeScript resolver finds alias/relative cycles and excludes generated Prisma', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sho-import-cycle-'));
  try {
    mkdirSync(path.join(root, 'src', 'generated'), { recursive: true });
    writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } }, include: ['src/**/*'],
    }));
    writeFileSync(path.join(root, 'src', 'a.ts'), "import './b'; export const a = 1;\n");
    writeFileSync(path.join(root, 'src', 'b.ts'), "import '@/a'; export const b = 2;\n");
    writeFileSync(path.join(root, 'src', 'generated', 'cycle.ts'), "import './cycle';\n");
    const graph = sourceImportGraph(root);
    assert.equal(graph.size, 2);
    assert.deepEqual(findImportCycles(graph), [[path.join(root, 'src', 'a.ts'), path.join(root, 'src', 'b.ts')]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
