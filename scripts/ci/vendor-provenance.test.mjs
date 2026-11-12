import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const manifest=JSON.parse(readFileSync('deploy/vendor-provenance.json','utf8'));
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
test('reviewed vendor archive and native source/binary identities remain pinned',()=>{
 assert.equal(hash(manifest.editor.archive),manifest.editor.archiveSHA256);
 assert.equal(hash(manifest.nativeShutdown.source),manifest.nativeShutdown.sourceSHA256);
 assert.equal(hash(manifest.nativeShutdown.binary),manifest.nativeShutdown.binarySHA256);
});
