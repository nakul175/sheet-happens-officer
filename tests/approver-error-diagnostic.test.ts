import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeApprover500Diagnostic } from './approver-error-diagnostic';

const owned: string[] = [];
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('retains a sanitized response ID when the server log is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sho-approver-diagnostic-'));
  owned.push(dir);
  const result = writeApprover500Diagnostic(
    '12345678-1234-1234-1234-123456789abc', 0,
    join(dir, 'missing.log'), join(dir, 'out', 'diagnostic.json'),
  );
  expect(result).toMatchObject({ logPresent: false, errorId: '12345678-1234-1234-1234-123456789abc', safeCodes: [], attribution: 'server log unavailable' });
  expect(JSON.parse(readFileSync(join(dir, 'out', 'diagnostic.json'), 'utf8'))).toEqual(result);
});

it('matches only the response ID and never stores raw log text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sho-approver-diagnostic-'));
  owned.push(dir);
  const log = join(dir, 'server.log');
  const id = '12345678-1234-1234-1234-123456789abc';
  writeFileSync(log, `ignore-this-prefix\nunexpected error P2010/55P03 ${id} secret-password\nunexpected error UNKNOWN 87654321-1234-1234-1234-123456789abc\n`);
  const output = join(dir, 'diagnostic.json');
  const result = writeApprover500Diagnostic(id, Buffer.byteLength('ignore-this-prefix\n'), log, output);
  expect(result).toMatchObject({ logPresent: true, safeCodes: ['P2010/55P03'], attribution: 'matched response ID' });
  expect(readFileSync(output, 'utf8')).not.toContain('secret-password');
});
